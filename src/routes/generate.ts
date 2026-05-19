import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { GenerateResponse, CounterResult, Category, LayoutConfig } from '../types';
import { generateCounterImage, PACK_WIDTH_CM } from '../services/imageGen';
import {
  SelectionContext,
  SelectionResult,
  ValidationError,
  ZoneAssignment,
  ZonePlacement,
} from '../services/strategies/types';
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
    const zonePlacements: ZonePlacement[] = selection.zonePlacements || [];

    // ---- 计算每柜台的 zone 行占用 ----
    // 校验:zonePlacements 必须落在 displayCounters 上,且每柜台总 zone 行 ≤ levels
    const cabinetZoneRows = new Map<string, number>();
    for (const p of zonePlacements) {
      const target = displayCounters.find((c: any) => c.id === p.counterId);
      if (!target) {
        const body: GenerateResponse = {
          success: false,
          error: `专区分配的柜台 ${p.counterId} 不存在或非前柜/吊柜`,
        };
        res.status(400).json(body);
        return;
      }
      cabinetZoneRows.set(p.counterId, (cabinetZoneRows.get(p.counterId) || 0) + p.rowCount);
    }
    for (const c of displayCounters) {
      const z = cabinetZoneRows.get(c.id) || 0;
      if (z > c.levels) {
        const body: GenerateResponse = {
          success: false,
          error: `柜台 ${c.id} 的专区行数 ${z} 超过总层数 ${c.levels}`,
        };
        res.status(400).json(body);
        return;
      }
    }

    // ---- 布局决策（基于常规陈列区容量,即扣除 zone 行后的剩余容量） ----
    const regularCapacities = displayCounters.map((c: any) => {
      const zRows = cabinetZoneRows.get(c.id) || 0;
      return Math.floor(c.length / PACK_WIDTH_CM) * (c.levels - zRows);
    });
    const regularLayerLengths = displayCounters.map((c: any) => {
      const zRows = cabinetZoneRows.get(c.id) || 0;
      return c.length * (c.levels - zRows);
    });
    const totalRegularCapacity = regularCapacities.reduce((s: number, v: number) => s + v, 0);
    const totalRegularLayerLength = regularLayerLengths.reduce((s: number, v: number) => s + v, 0);

    let layout: LayoutConfig;
    const specCount = specs.length;
    if (totalRegularCapacity === 0) {
      layout = { mode: 'standard', gapCm: 0 };
    } else if (specCount >= totalRegularCapacity) {
      layout = { mode: 'standard', gapCm: 0 };
    } else if (specCount > 0 && specCount < totalRegularCapacity / 2) {
      const gapCm = totalRegularLayerLength / specCount - 2 * PACK_WIDTH_CM;
      layout = { mode: 'double', gapCm: Math.max(gapCm, 0) };
    } else if (specCount > 0) {
      const gapCm = totalRegularLayerLength / specCount - PACK_WIDTH_CM;
      layout = { mode: 'expanded', gapCm: Math.max(gapCm, 0) };
    } else {
      layout = { mode: 'standard', gapCm: 0 };
    }

    // ---- 按常规容量比例分配 regular specs 到各柜台 ----
    let allocations: number[];
    if (specCount >= totalRegularCapacity) {
      allocations = [...regularCapacities];
    } else if (totalRegularCapacity === 0) {
      allocations = displayCounters.map(() => 0);
    } else {
      allocations = regularCapacities.map((cap: number) =>
        Math.round(specCount * cap / totalRegularCapacity)
      );
      let diff = specCount - allocations.reduce((s, v) => s + v, 0);
      const sortedIdx = regularCapacities
        .map((_: number, i: number) => i)
        .sort((a: number, b: number) => regularCapacities[b] - regularCapacities[a]);
      for (let k = 0; diff !== 0; k = (k + 1) % sortedIdx.length) {
        const idx = sortedIdx[k];
        if (diff > 0 && allocations[idx] < regularCapacities[idx]) {
          allocations[idx]++;
          diff--;
        } else if (diff < 0 && allocations[idx] > 0) {
          allocations[idx]--;
          diff++;
        }
      }
    }

    // ---- 按各柜台分配量收紧 gap，避免 calcMaxPerRow 的 floor() 静默截断 ----
    if (layout.mode === 'expanded' || layout.mode === 'double') {
      const packsPerSpec = layout.mode === 'double' ? 2 : 1;
      let tightestGap = layout.gapCm;
      for (let i = 0; i < displayCounters.length; i++) {
        const cabinet = displayCounters[i];
        const assigned = allocations[i];
        if (assigned === 0) continue;
        const zRows = cabinetZoneRows.get(cabinet.id) || 0;
        const availableLevels = cabinet.levels - zRows;
        if (availableLevels <= 0) continue;
        const neededPerRow = Math.ceil(assigned / availableLevels);
        const maxFittingGapCm = neededPerRow > 1
          ? (cabinet.length - neededPerRow * packsPerSpec * PACK_WIDTH_CM) / (neededPerRow - 1)
          : Infinity;
        const fit = Math.max(maxFittingGapCm, 0);
        if (fit < tightestGap) tightestGap = fit;
      }
      layout = { ...layout, gapCm: tightestGap };
    }

    // ---- 全局 id→出现次数（用于 imageGen 在 double 模式下区分多选/单选品规） ----
    const occurrenceCounts = new Map<string, number>();
    for (const sp of specs) {
      occurrenceCounts.set(sp.id, (occurrenceCounts.get(sp.id) || 0) + 1);
    }

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
      const { imageUrl } = await generateCounterImage(cabinet, cabinetSpecs, layout, occurrenceCounts, cabinetZones);
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
