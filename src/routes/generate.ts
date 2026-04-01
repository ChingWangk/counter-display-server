import { Router, Request, Response } from 'express';
import { GenerateRequest, GenerateResponse, CounterResult } from '../types';
import { sortCategories } from '../services/sortCategories';
import { generateCounterImage, filterWithImages } from '../services/imageGen';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const { counters, categories } = req.body as GenerateRequest;

    if (!Array.isArray(counters) || counters.length === 0) {
      const body: GenerateResponse = { success: false, error: '柜台列表不能为空' };
      res.status(400).json(body);
      return;
    }

    // categories = 用户勾选的品规（即本店有进货的品规，直接作为可用列表）
    const available = Array.isArray(categories) ? categories : [];

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
