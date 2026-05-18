import { Router, Request, Response } from 'express';
import { getExtendedCategoryList } from '../services/categoryCatalog';

const router = Router();

/**
 * GET /api/categories — 返回 categories.json + dim_category_ext 合并后的全量品类。
 * 合并逻辑与缓存集中在 services/categoryCatalog.ts，策略模块也使用同一份缓存。
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const categories = await getExtendedCategoryList();
    res.json({ success: true, categories });
  } catch (err) {
    console.error('Query categories error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
