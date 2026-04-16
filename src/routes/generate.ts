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

      const sorted = sortCategories(pool_);
      let withImages = sorted;

      // 计算陈列资源（前柜+吊柜总容量）
      const totalSlots = displayCounters.reduce((sum: number, c: any) => {
        return sum + Math.floor(c.length / PACK_WIDTH_CM) * c.levels;
      }, 0);
      // 各层长度之和（cm）
      const totalLayerLength = displayCounters.reduce((sum: number, c: any) => {
        return sum + c.length * c.levels;
      }, 0);

      const specCount = withImages.length;

      if (specCount > totalSlots) {
        // ---- 陈列资源匮乏：去掉紧俏烟 ----
        withImages = withImages.filter(c => !c.is_hot);
        layout = { mode: 'standard', gapCm: 0 };
      } else if (specCount < totalSlots / 2) {
        // ---- 充足 · 情况一：双包陈列 ----
        const gapCm = totalLayerLength / specCount - 2 * PACK_WIDTH_CM;
        layout = { mode: 'double', gapCm: Math.max(gapCm, 0) };
      } else {
        // ---- 充足 · 情况二：扩大单包间距 ----
        const gapCm = totalLayerLength / specCount - PACK_WIDTH_CM;
        layout = { mode: 'expanded', gapCm: Math.max(gapCm, 0) };
      }

      specs = withImages;
    } else {
      // 自选规格：使用用户勾选的品类
      const ids: string[] = Array.isArray(categories)
        ? categories.map((c: { id: string }) => c.id)
        : [];
      const available = ids
        .map(id => categoryMap.get(id))
        .filter((c): c is Category => c !== undefined);

      specs = sortCategories(available);
      layout = { mode: 'standard', gapCm: 0 };
    }

    // ---- 生成前柜/吊柜图片（多柜台去重） ----
    const results: CounterResult[] = [];
    let remaining = [...specs];

    for (const counter of displayCounters) {
      const { imageUrl, usedCount } = await generateCounterImage(counter, remaining, layout);
      results.push({
        counterId: counter.id,
        counterType: counter.type,
        imageUrl,
      });
      // 去重：已分配的品规不再用于下一个柜台
      remaining = remaining.slice(usedCount);
    }

    // ---- 背柜占位（主题陈列由前端背柜自选页处理） ----
    for (const counter of backCounters) {
      results.push({
        counterId: counter.id,
        counterType: counter.type,
        imageUrl: 'mock:back',
      });
    }

    const body: GenerateResponse = { success: true, results };
    res.json(body);
  } catch (err) {
    console.error('Generate error:', err);
    const message = err instanceof Error ? err.message : '图片生成失败';
    const body: GenerateResponse = { success: false, error: message };
    res.status(500).json(body);
  }
});

export default router;
