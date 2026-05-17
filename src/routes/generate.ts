import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { GenerateResponse, CounterResult, Category, LayoutConfig } from '../types';
import { generateCounterImage, PACK_WIDTH_CM } from '../services/imageGen';
import { SelectionContext, SelectionResult, ValidationError } from '../services/strategies/types';
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
    const { counters, categories, mode = 'manual', customer_id } = req.body;

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

    // ---- 布局决策（smart / manual 共享）：基于品规数 vs 陈列总容量 ----
    let layout: LayoutConfig;
    const specCount = specs.length;
    if (specCount >= totalSlots) {
      // 资源刚好或不足：紧贴标准布局
      layout = { mode: 'standard', gapCm: 0 };
    } else if (specCount < totalSlots / 2) {
      // 资源充足：双包陈列
      const gapCm = totalLayerLength / specCount - 2 * PACK_WIDTH_CM;
      layout = { mode: 'double', gapCm: Math.max(gapCm, 0) };
    } else {
      // 资源中等：扩大单包间距
      const gapCm = totalLayerLength / specCount - PACK_WIDTH_CM;
      layout = { mode: 'expanded', gapCm: Math.max(gapCm, 0) };
    }

    // ---- 按容量比例分配品规到各柜台 ----
    const results: CounterResult[] = [];

    const capacities = displayCounters.map((c: any) =>
      Math.floor(c.length / PACK_WIDTH_CM) * c.levels
    );
    const totalCapacity = capacities.reduce((s: number, v: number) => s + v, 0);
    const totalSpecs = specs.length;

    // 按比例分配，不足时按容量比例缩放；超出时各柜台取满
    let allocations: number[];
    if (totalSpecs >= totalCapacity) {
      allocations = [...capacities];
    } else {
      allocations = capacities.map((cap: number) =>
        Math.round(totalSpecs * cap / totalCapacity)
      );
      // 修正四舍五入误差
      let diff = totalSpecs - allocations.reduce((s, v) => s + v, 0);
      // 按容量从大到小调整
      const sortedIdx = capacities
        .map((_: number, i: number) => i)
        .sort((a: number, b: number) => capacities[b] - capacities[a]);
      for (let k = 0; diff !== 0; k = (k + 1) % sortedIdx.length) {
        const idx = sortedIdx[k];
        if (diff > 0 && allocations[idx] < capacities[idx]) {
          allocations[idx]++;
          diff--;
        } else if (diff < 0 && allocations[idx] > 0) {
          allocations[idx]--;
          diff++;
        }
      }
    }

    // ---- 按各柜台分配量收紧 gap，避免 calcMaxPerRow 的 floor() 静默截断 ----
    // 原 gap 按"平均"反算，但每行可容量 = floor((canvasW+gap)/slotW) 会吃掉小数位，导致某些柜台放不下
    // 取所有柜台"能塞下各自分配量的最大 gap"的最小值作为统一 gap
    if (layout.mode === 'expanded' || layout.mode === 'double') {
      const packsPerSpec = layout.mode === 'double' ? 2 : 1;
      let tightestGap = layout.gapCm;
      for (let i = 0; i < displayCounters.length; i++) {
        const cabinet = displayCounters[i];
        const assigned = allocations[i];
        if (assigned === 0) continue;
        const neededPerRow = Math.ceil(assigned / cabinet.levels);
        // 由 n*(packW+gap) ≤ canvasW + gap  →  gap ≤ (canvasW - n*packW)/(n-1)
        const maxFittingGapCm = neededPerRow > 1
          ? (cabinet.length - neededPerRow * packsPerSpec * PACK_WIDTH_CM) / (neededPerRow - 1)
          : Infinity;
        const fit = Math.max(maxFittingGapCm, 0);
        if (fit < tightestGap) tightestGap = fit;
      }
      layout = { ...layout, gapCm: tightestGap };
    }

    let offset = 0;
    // 全局 id→出现次数（用于 imageGen 在 double 模式下区分多选/单选品规）
    const occurrenceCounts = new Map<string, number>();
    for (const sp of specs) {
      occurrenceCounts.set(sp.id, (occurrenceCounts.get(sp.id) || 0) + 1);
    }
    for (let i = 0; i < displayCounters.length; i++) {
      const cabinetSpecs = specs.slice(offset, offset + allocations[i]);
      const { imageUrl } = await generateCounterImage(displayCounters[i], cabinetSpecs, layout, occurrenceCounts);
      results.push({
        counterId: displayCounters[i].id,
        counterType: displayCounters[i].type,
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
