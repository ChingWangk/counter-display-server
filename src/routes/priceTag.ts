import { Router, Request, Response } from 'express';
import { getCustomerPriceComparison } from '../services/priceTag';
import { getCustomerHasPos } from '../services/strategies/substitute';

const router = Router();

/**
 * GET /api/price-tag/comparison?customer_id=xxx
 * 价签助手「价格对照表」：按客户 has_pos 白名单，返回区域常卖价 × 客户当前售价。
 * 白名单规格全列出；查不到客户售价的 my_price=null（前端标"暂无记录"）。
 * 任一数据表缺失时降级为空/仅区域价，不报错。
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
