import { Router, Request, Response } from 'express';
import { getSubstituteDetails, getCustomerStockoutList, SubstitutePair } from '../services/substituteDetail';

const router = Router();

/**
 * GET /api/substitute-detail?customer_id=X&pairs=primaryA:subA,primaryB:subB
 * 平替专区两张表的数据：
 *  - stockoutList：门店「全部当前脱销规格 + 脱销天数」（cust_stockout 全量，供《脱销明细表》，
 *    与 pairs 无关——反映真实脱销面，是组合表的超集）。
 *  - details：每个「有平替」的组返回 平替点 + 平替款胀库 + 脱销天数（供《脱销平替对照表》）。
 * pairs 由前端 zoneGroups（primary + 首选 alternatives[0]）拼出；仅传 customer_id（pairs 空）也会回 stockoutList。
 * 参数缺失/表未就绪时降级为空数组（前端只出正文、不渲染对应表）。
 */
router.get('/', async (req: Request, res: Response) => {
  const customerId = String(req.query.customer_id || '').trim();
  const raw = String(req.query.pairs || '').trim();
  const pairs: SubstitutePair[] = raw
    ? raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => {
          const [primaryId, subId] = s.split(':').map(x => x.trim());
          return { primaryId, subId };
        })
        .filter(p => p.primaryId && p.subId)
    : [];

  try {
    const [details, stockoutList] = await Promise.all([
      getSubstituteDetails(customerId, pairs),
      getCustomerStockoutList(customerId),
    ]);
    res.json({ success: true, details, stockoutList });
  } catch (err) {
    console.error('substitute-detail error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
