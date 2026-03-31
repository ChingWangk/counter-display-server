import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { GenerateRequest, GenerateResponse, Category, CounterResult } from '../types';
import { sortCategories } from '../services/sortCategories';
import { generateCounterImage } from '../services/imageGen';

const router = Router();

/** 读取完整品类列表 */
function loadAllCategories(): Category[] {
  const filePath = path.join(__dirname, '../data/categories.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const { counters, categories } = req.body as GenerateRequest;

    if (!Array.isArray(counters) || counters.length === 0) {
      const body: GenerateResponse = { success: false, error: '柜台列表不能为空' };
      res.status(400).json(body);
      return;
    }

    // categories = 用户勾选的品规（排除项）
    const excludeIds = new Set(
      Array.isArray(categories) ? categories.map(c => c.id) : []
    );

    // 从全部品规中排除勾选的，得到可放列表
    const allCategories = loadAllCategories();
    const available = allCategories.filter(c => !excludeIds.has(c.id));

    // 按规则排序
    const sorted = sortCategories(available);

    // 为每个柜台生成图片
    const results: CounterResult[] = [];
    for (const counter of counters) {
      const imageUrl = await generateCounterImage(counter, sorted);
      results.push({
        counterId: counter.id,
        counterType: counter.type,
        imageUrl,
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
