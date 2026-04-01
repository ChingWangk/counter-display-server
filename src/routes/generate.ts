import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { GenerateResponse, CounterResult, Category } from '../types';
import { sortCategories } from '../services/sortCategories';
import { generateCounterImage, filterWithImages } from '../services/imageGen';

// 加载完整品类数据，建立 id → Category 映射
const categoriesFile = path.join(__dirname, '../data/categories.json');
const allCategories: Category[] = JSON.parse(fs.readFileSync(categoriesFile, 'utf-8'));
const categoryMap = new Map<string, Category>(allCategories.map(c => [c.id, c]));

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const { counters, categories } = req.body;

    if (!Array.isArray(counters) || counters.length === 0) {
      const body: GenerateResponse = { success: false, error: '柜台列表不能为空' };
      res.status(400).json(body);
      return;
    }

    // 前端只需传 id，后端根据 id 查完整品类信息
    const ids: string[] = Array.isArray(categories)
      ? categories.map((c: { id: string }) => c.id)
      : [];
    const available = ids
      .map(id => categoryMap.get(id))
      .filter((c): c is Category => c !== undefined);

    // 按规则排序
    const sorted = sortCategories(available);

    // 过滤掉服务器上没有图片的品规
    const withImages = filterWithImages(sorted);

    // 为每个柜台生成图片
    const results: CounterResult[] = [];
    for (const counter of counters) {
      const imageUrl = await generateCounterImage(counter, withImages);
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
