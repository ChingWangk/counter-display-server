import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { GenerateResponse, CounterResult, Category } from '../types';
import { generateCounterImage, PACK_WIDTH_CM } from '../services/imageGen';
import {
  SelectionContext,
  SelectionResult,
  ValidationError,
  ZoneAssignment,
  ZonePlacement,
  ZONE_META,
  FestivalId,
} from '../services/strategies/types';
import { autoExpandZonePlacements } from '../services/strategies/zones';
import { selectFestivalImage } from '../services/strategies/festivalSeason';
import { getExtendedCategoryMap } from '../services/categoryCatalog';
import { manualStrategy } from '../services/strategies/manualStrategy';
import { newCustomerStrategy } from '../services/strategies/newCustomerStrategy';
import { regularCustomerStrategy } from '../services/strategies/regularCustomerStrategy';
import { getCustomerClass } from '../services/customerClass';
import { getCustomerHasPos } from '../services/strategies/substitute';
import { getPriceTagMap } from '../services/priceTag';

// 加载背柜主题组数据
interface ThemeGroup { id: string; label: string; specIds: string[]; images: string[]; }
const themesFile = path.join(__dirname, '../data/back-cabinet-themes.json');
const allThemes: ThemeGroup[] = JSON.parse(fs.readFileSync(themesFile, 'utf-8'));
const IMAGE_PREFIX = '/images/back-themes/';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    console.log('[DEBUG] 收到 req.body:', JSON.stringify(req.body));
    const {
      counters,
      categories,
      mode = 'manual',
      customer_id,
      zone_assignments,
    } = req.body as {
      counters: any[];
      categories: any[];
      mode?: 'smart' | 'manual';
      customer_id?: string;
      zone_assignments?: ZoneAssignment[];
    };

    if (!Array.isArray(counters) || counters.length === 0) {
      const body: GenerateResponse = { success: false, error: '柜台列表不能为空' };
      res.status(400).json(body);
      return;
    }

    // 按类型分离柜台：前柜/吊柜参与烟包陈列，背柜单独处理
    const displayCounters = counters.filter((c: any) => c.type === 'front' || c.type === 'hanging');
    const backCounters = counters.filter((c: any) => c.type === 'back');

    // ---- 拆分 zone_assignments:displayCabinet(前柜/吊柜) vs backCabinet(背柜) ----
    // backCabinet 类目(目前仅 festivalSeason)与其他 zone 的数据流完全隔离 —— 不进 selection,
    // 不进 imageGen,由本路由的背柜分支单独处理。
    const allAssignments: ZoneAssignment[] = Array.isArray(zone_assignments) ? zone_assignments : [];
    const displayCabinetAssignments: ZoneAssignment[] = [];
    const backCabinetAssignments: ZoneAssignment[] = [];
    for (const a of allAssignments) {
      const meta = ZONE_META[a.zone_id];
      if (!meta) continue;  // 未知 zone_id 静默忽略(前后端版本不一致时容忍)
      if (meta.targetCabinetType === 'backCabinet') {
        backCabinetAssignments.push(a);
      } else {
        displayCabinetAssignments.push(a);
      }
    }

    // 校验 backCabinetAssignments
    for (const a of backCabinetAssignments) {
      const target = backCounters.find((c: any) => c.id === a.counter_id);
      if (!target) {
        const body: GenerateResponse = {
          success: false,
          error: `专区分配的柜台 ${a.counter_id} 不存在或非背柜`,
        };
        res.status(400).json(body);
        return;
      }
      if (a.zone_id === 'festivalSeason' && !a.festival_id) {
        const body: GenerateResponse = {
          success: false,
          error: `节日季节专区(背柜 ${a.counter_id})缺少 festival_id`,
        };
        res.status(400).json(body);
        return;
      }
    }

    // 陈列资源（前柜+吊柜），smart/manual 共用
    const totalSlots = displayCounters.reduce((sum: number, c: any) => {
      return sum + Math.floor(c.length / PACK_WIDTH_CM) * c.levels;
    }, 0);
    const totalLayerLength = displayCounters.reduce((sum: number, c: any) => {
      return sum + c.length * c.levels;
    }, 0);

    // ---- 调度选品策略：manual / newCustomer / regularCustomer 三选一 ----
    const ctx: SelectionContext = {
      customerId: customer_id,
      totalSlots,
      totalLayerLength,
      requestCategories: Array.isArray(categories) ? categories : [],
      zoneAssignments: displayCabinetAssignments,
    };

    let selection: SelectionResult;
    try {
      if (mode === 'manual') {
        selection = await manualStrategy(ctx);
      } else {
        // mode === 'smart'：按客户类型分发
        const customerClass = await getCustomerClass(customer_id || '');
        selection = customerClass === 'regular'
          ? await regularCustomerStrategy(ctx)
          : await newCustomerStrategy(ctx);
      }
    } catch (err) {
      if (err instanceof ValidationError) {
        const body: GenerateResponse = { success: false, error: err.message };
        res.status(400).json(body);
        return;
      }
      throw err;
    }

    const specs: Category[] = selection.specs;
    const usedSpecIds: Set<string> = selection.usedSpecIds;
    const filteredHotSpecs: { id: string; name: string }[] = selection.filteredHotSpecs || [];
    const initialZonePlacements: ZonePlacement[] = selection.zonePlacements || [];

    // ---- 校验初始 zonePlacements 落位的柜台合法 ----
    for (const p of initialZonePlacements) {
      const target = displayCounters.find((c: any) => c.id === p.counterId);
      if (!target) {
        const body: GenerateResponse = {
          success: false,
          error: `专区分配的柜台 ${p.counterId} 不存在或非前柜/吊柜`,
        };
        res.status(400).json(body);
        return;
      }
    }

    // ---- 顺序分配 regular specs:假设无 zone,前置柜台先吃满 ----
    // 业务规则:常规陈列先沿前置柜台铺满,被常规填满的层不允许放置专区。
    const specCount = specs.length;
    const allocations: number[] = [];
    const regularRowsByCounter = new Map<string, number>();
    let remaining = specCount;
    for (const c of displayCounters) {
      const packsPerRow = Math.floor(c.length / PACK_WIDTH_CM);
      const cap = packsPerRow * c.levels;
      const used = Math.min(remaining, cap);
      allocations.push(used);
      remaining -= used;
      regularRowsByCounter.set(
        c.id,
        packsPerRow > 0 ? Math.min(c.levels, Math.ceil(used / packsPerRow)) : 0,
      );
    }

    // ---- 校验:用户分配的 zone 行数必须落在「常规之外的空闲层」内 ----
    const initialZoneRowsByCounter = new Map<string, number>();
    for (const p of initialZonePlacements) {
      initialZoneRowsByCounter.set(
        p.counterId,
        (initialZoneRowsByCounter.get(p.counterId) || 0) + p.rowCount,
      );
    }
    for (const c of displayCounters) {
      const zRows = initialZoneRowsByCounter.get(c.id) || 0;
      const regRows = regularRowsByCounter.get(c.id) || 0;
      const freeRows = c.levels - regRows;
      if (zRows > freeRows) {
        const body: GenerateResponse = {
          success: false,
          error: `柜台 ${c.id} 仅剩 ${freeRows} 行可放专区,无法容纳 ${zRows} 行`,
        };
        res.status(400).json(body);
        return;
      }
    }

    // ---- 自动扩展:把每个柜台剩余空行用已启用的专区填满(groupCount 优先,上限即柜台空闲层数) ----
    const zonePlacements: ZonePlacement[] = autoExpandZonePlacements(
      initialZonePlacements,
      displayCounters,
      regularRowsByCounter,
    );

    // ---- 拉价签白名单:根据 cust_info.has_pos 决定 ref_yangpu_avg_price 子集 ----
    // 有 customer_id 才有比对依据;无 customer_id 时空 Map,imageGen 不画价签。
    let priceTagMap = new Map<string, number>();
    if (customer_id) {
      const hasPos = await getCustomerHasPos(customer_id);
      priceTagMap = await getPriceTagMap(hasPos);
    }

    // ---- 逐柜台生成图片 ----
    const results: CounterResult[] = [];
    let offset = 0;
    for (let i = 0; i < displayCounters.length; i++) {
      const cabinet = displayCounters[i];
      const cabinetSpecs = specs.slice(offset, offset + allocations[i]);
      const cabinetZones = zonePlacements.filter(p => p.counterId === cabinet.id);
      // zone usedSpecIds 也要并入,用于背柜主题匹配:遍历 groups 收集 primary + alternatives
      for (const p of cabinetZones) {
        for (const g of p.groups) {
          usedSpecIds.add(g.primary.id);
          for (const a of g.alternatives) usedSpecIds.add(a.id);
        }
      }
      const regRows = regularRowsByCounter.get(cabinet.id) || 0;
      const { imageUrl } = await generateCounterImage(cabinet, cabinetSpecs, regRows, cabinetZones, priceTagMap);
      results.push({
        counterId: cabinet.id,
        counterType: cabinet.type,
        imageUrl,
      });
      offset += allocations[i];
    }

    // ---- 背柜:节日季节专区优先(单图直出);未命中节日的背柜走主题图逻辑 ----
    // 节日命中的背柜跳过 back-cabinet-select 主题匹配,跟用户在 zone-select 上的"节日优先"约定一致。
    const festivalByBackCounter = new Map<string, FestivalId>();
    for (const a of backCabinetAssignments) {
      if (a.zone_id === 'festivalSeason' && a.festival_id) {
        festivalByBackCounter.set(a.counter_id, a.festival_id);
      }
    }
    let extendedMap: ReadonlyMap<string, Category> | null = null;
    if (festivalByBackCounter.size > 0) {
      extendedMap = await getExtendedCategoryMap();
    }
    const customerSpecIds = new Set(specs.map((c: Category) => c.id));

    const matchedThemes = allThemes.filter(
      t => t.specIds.some(id => usedSpecIds.has(id))
    );
    const allThemeImages = matchedThemes.flatMap(
      t => t.images.map(img => IMAGE_PREFIX + img)
    );

    for (const counter of backCounters) {
      const festivalId = festivalByBackCounter.get(counter.id);
      if (festivalId && extendedMap) {
        const festivalUrl = await selectFestivalImage(
          festivalId,
          customerSpecIds,
          extendedMap,
          new Date(),
        );
        if (festivalUrl) {
          results.push({
            counterId: counter.id,
            counterType: counter.type,
            imageUrl: festivalUrl,
            layerImages: [festivalUrl],
          });
          continue;
        }
        // 选不到图(目录空 / 候选与客户无交集): 降级走主题图逻辑
      }

      const layerImages: string[] = [];
      for (let li = 0; li < counter.levels; li++) {
        if (allThemeImages.length > 0) {
          layerImages.push(allThemeImages[li % allThemeImages.length]);
        }
      }
      results.push({
        counterId: counter.id,
        counterType: counter.type,
        imageUrl: layerImages.length > 0 ? layerImages[0] : 'mock:back',
        layerImages,
      });
    }

    // ---- 合并 festivalSeason 的 ZonePlacement 到响应 zonePlacements ----
    // selection 不知道 festivalSeason 的存在,这里单独构造占位 placement 供前端 result chip 展示。
    const festivalPlacements: ZonePlacement[] = [];
    const festivalMeta = ZONE_META.festivalSeason;
    for (const a of backCabinetAssignments) {
      if (a.zone_id === 'festivalSeason' && a.festival_id) {
        festivalPlacements.push({
          zoneId: 'festivalSeason',
          label: festivalMeta.label,
          counterId: a.counter_id,
          rowCount: 1,
          groups: [],
          displayMode: 'backFestival',
          barColor: festivalMeta.barColor,
          priorityRank: festivalMeta.priorityRank,
          groupCount: 1,
        });
      }
    }
    const allZonePlacements = [...zonePlacements, ...festivalPlacements];

    const body: GenerateResponse = {
      success: true,
      results,
      ...(filteredHotSpecs.length > 0 ? { filteredHotSpecs } : {}),
      ...(allZonePlacements.length > 0 ? { zonePlacements: allZonePlacements } : {}),
    };
    res.json(body);
  } catch (err) {
    console.error('Generate error:', err);
    const message = err instanceof Error ? err.message : '图片生成失败';
    const body: GenerateResponse = { success: false, error: message };
    res.status(500).json(body);
  }
});

export default router;
