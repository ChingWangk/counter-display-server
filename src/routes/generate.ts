import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { GenerateResponse, CounterResult, Category, LayoutConfig } from '../types';
import { sortCategories } from '../services/sortCategories';
import { generateCounterImage, PACK_WIDTH_CM } from '../services/imageGen';
import pool from '../db';
import { RowDataPacket } from 'mysql2';



// 加载完整品类数据，建立 id → Category 映射
const categoriesFile = path.join(__dirname, '../data/categories.json');
const allCategories: Category[] = JSON.parse(fs.readFileSync(categoriesFile, 'utf-8'));
const categoryMap = new Map<string, Category>(allCategories.map(c => [c.id, c]));

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

    // ---- 确定品规列表和布局策略 ----
    let specs: Category[];
    let layout: LayoutConfig;
    let filteredHotSpecs: { id: string; name: string }[] = [];

    // 陈列资源（前柜+吊柜），smart/manual 共用
    const totalSlots = displayCounters.reduce((sum: number, c: any) => {
      return sum + Math.floor(c.length / PACK_WIDTH_CM) * c.levels;
    }, 0);
    const totalLayerLength = displayCounters.reduce((sum: number, c: any) => {
      return sum + c.length * c.levels;
    }, 0);

    if (mode === 'smart') {
      // 智能推荐：确定品规池
      let pool_: Category[];

      if (customer_id) {
        // 有客户ID → 从数据库查该客户的规格明细
        const [rows] = await pool.execute<RowDataPacket[]>(
          'SELECT spec_detail FROM customer_specs WHERE customer_id = ?',
          [customer_id]
        );
        if (rows.length > 0 && rows[0].spec_detail) {
          // spec_detail 存的是逗号分隔的品规 ID
          const ids: string[] = rows[0].spec_detail.split(',').map((s: string) => s.trim());
          pool_ = ids
            .map(id => categoryMap.get(id))
            .filter((c): c is Category => c !== undefined);
        } else {
          pool_ = [...allCategories];
        }
      } else {
        // 无客户ID → 使用全部品类
        pool_ = [...allCategories];
      }

      let withImages = sortCategories(pool_);

      // 资源匮乏时过滤紧俏烟（仅智能推荐模式）
      // 例外：批发价 > 600 元/条的高价烟必须保留（门店刚需），即便是紧俏烟也不剔除
      if (withImages.length > totalSlots) {
        const HIGH_PRICE_PROTECT = 600;
        const hotSpecs = withImages.filter(c => c.is_hot && c.price <= HIGH_PRICE_PROTECT);
        filteredHotSpecs = hotSpecs.map(c => ({ id: c.id, name: c.name }));
        const removeIds = new Set(hotSpecs.map(c => c.id));
        withImages = withImages.filter(c => !removeIds.has(c.id));
      }

      specs = withImages;
    } else {
      // 自选规格：使用用户勾选的品类（允许同一品类重复，表示多包陈列）
      const ids: string[] = Array.isArray(categories)
        ? categories.map((c: { id: string }) => c.id)
        : [];
      const available = ids
        .map(id => categoryMap.get(id))
        .filter((c): c is Category => c !== undefined);

      specs = sortCategories(available);
    }

    // ---- 布局决策（smart / manual 共享）：基于品规数 vs 陈列总容量 ----
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

    let offset = 0;
    for (let i = 0; i < displayCounters.length; i++) {
      const cabinetSpecs = specs.slice(offset, offset + allocations[i]);
      const { imageUrl } = await generateCounterImage(displayCounters[i], cabinetSpecs, layout);
      results.push({
        counterId: displayCounters[i].id,
        counterType: displayCounters[i].type,
        imageUrl,
      });
      offset += allocations[i];
    }

    // ---- 背柜占位（主题陈列由前端背柜自选页处理） ----
    for (const counter of backCounters) {
      results.push({
        counterId: counter.id,
        counterType: counter.type,
        imageUrl: 'mock:back',
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
