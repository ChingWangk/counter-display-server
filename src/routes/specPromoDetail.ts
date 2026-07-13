import { Router, Request, Response } from 'express';
import { getSpecPromoDetails } from '../services/specPromoDetail';

const router = Router();

/**
 * GET /api/spec-promo-detail?ids=001,002,003
 * 共育政策官「产品详情表」：按规格 id 返回 价格/支型/口味特色/适销人群（读 dim_category_ext）。
 * ids 为空 → 空数组；表/列未就绪时降级为空数组（前端不渲染详情表，仅保留布局说明）。
 */
router.get('/', async (req: Request, res: Response) => {
  const raw = String(req.query.ids || '').trim();
  const ids = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  try {
    const details = await getSpecPromoDetails(ids);
    res.json({ success: true, details });
  } catch (err) {
    console.error('spec-promo-detail error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
