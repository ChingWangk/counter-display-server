import { Router, Request, Response } from 'express';
import { getCustomerPriceComparison } from '../services/priceTag';
import { getCustomerHasPos } from '../services/strategies/substitute';

const router = Router();

/**
 * GET /api/price-tag/comparison?customer_id=xxx
 * 价签助手「待升价对照表」：按客户 has_pos 白名单，只返回"客户售价 < 区域常卖价"的规格
 * （核心是提醒老板把这几款调高；卖到位/查不到售价的一律不列）。
 * rows 为空即"无需升价"，前端据此不弹价签助手入口。任一数据表缺失时降级为空表，不报错。
 */
router.get('/comparison', async (req: Request, res: Response) => {
  const customerId = String(req.query.customer_id || '').trim();
  if (!customerId) {
    res.status(400).json({ success: false, error: '缺少 customer_id' });
    return;
  }
  try {
    const hasPos = await getCustomerHasPos(customerId);
    const data = await getCustomerPriceComparison(customerId, hasPos);
    res.json({ success: true, hasPos, ...data });
  } catch (err) {
    console.error('price-tag comparison error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
