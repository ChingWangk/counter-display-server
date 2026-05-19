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
} from '../services/strategies/types';
import { autoExpandZonePlacements } from '../services/strategies/zones';
import { manualStrategy } from '../services/strategies/manualStrategy';
import { newCustomerStrategy } from '../services/strategies/newCustomerStrategy';
import { regularCustomerStrategy } from '../services/strategies/regularCustomerStrategy';
import { getCustomerClass } from '../services/customerClass';

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
      zoneAssignments: Array.isArray(zone_assignments) ? zone_assignments : [],
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

    // ---- 校验:用户分配的 zone 行数必须落在「常规之外的空闲层」内 + 单柜台 ≤ 4 ----
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
      if (zRows > 4) {
        const body: GenerateResponse = {
          success: false,
          error: `柜台 ${c.id} 的专区行数 ${zRows} 超过单柜台上限 4 行`,
        };
        res.status(400).json(body);
        return;
      }
      if (zRows > freeRows) {
        const body: GenerateResponse = {
          success: false,
          error: `柜台 ${c.id} 仅剩 ${freeRows} 行可放专区,无法容纳 ${zRows} 行`,
        };
        res.status(400).json(body);
        return;
      }
    }

    // ---- 自动扩展:把每个柜台剩余空行用已启用的专区填满(specCount 优先,单柜台累计 ≤ 4) ----
    const zonePlacements: ZonePlacement[] = autoExpandZonePlacements(
      initialZonePlacements,
      displayCounters,
      regularRowsByCounter,
    );

    // ---- 逐柜台生成图片 ----
    const results: CounterResult[] = [];
    let offset = 0;
    for (let i = 0; i < displayCounters.length; i++) {
      const cabinet = displayCounters[i];
      const cabinetSpecs = specs.slice(offset, offset + allocations[i]);
      const cabinetZones = zonePlacements.filter(p => p.counterId === cabinet.id);
      // zone usedSpecIds 也要并入,用于背柜主题匹配
      for (const p of cabinetZones) {
        for (const s of p.specs) usedSpecIds.add(s.id);
      }
      const regRows = regularRowsByCounter.get(cabinet.id) || 0;
      const { imageUrl } = await generateCounterImage(cabinet, cabinetSpecs, regRows, cabinetZones);
      results.push({
        counterId: cabinet.id,
        counterType: cabinet.type,
        imageUrl,
      });
      offset += allocations[i];
    }

    // ---- 背柜：根据品规匹配主题组，为每层分配主题图 ----
    const matchedThemes = allThemes.filter(
      t => t.specIds.some(id => usedSpecIds.has(id))
    );
    const allThemeImages = matchedThemes.flatMap(
      t => t.images.map(img => IMAGE_PREFIX + img)
    );

    for (const counter of backCounters) {
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

    const body: GenerateResponse = {
      success: true,
      results,
      ...(filteredHotSpecs.length > 0 ? { filteredHotSpecs } : {}),
      ...(zonePlacements.length > 0 ? { zonePlacements } : {}),
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
