import { Router, Request, Response } from 'express';
import { getSubstituteDetails, SubstitutePair } from '../services/substituteDetail';

const router = Router();

/**
 * GET /api/substitute-detail?customer_id=X&pairs=primaryA:subA,primaryB:subB
 * 《脱销平替对照表》数据：每个「有平替」的组返回 平替点 + 平替款胀库。
 * pairs 由前端 zoneGroups（primary + 首选 alternatives[0]）拼出。
 * 参数缺失/表未就绪时降级为空数组（前端只出正文、不渲染表）。
 *
 * 历史：曾一并返回 stockoutList（门店 cust_stockout 全量脱销面，供《脱销明细表》）。该表已下线——
 * 其"门店脱销 N 个"与柜台绿框组合数并列易被误读成"全店只脱销这几个"，且它按「当前仍连续脱销」取数，
 * 与绿框改用的「近一周出现过脱销」口径不一致。
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
    const details = await getSubstituteDetails(customerId, pairs);
    res.json({ success: true, details });
  } catch (err) {
    console.error('substitute-detail error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
