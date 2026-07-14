import { Router, Request, Response } from 'express';
import { getSubstituteDetails, SubstitutePair } from '../services/substituteDetail';

const router = Router();

/**
 * GET /api/substitute-detail?customer_id=X&pairs=primaryA:subA,primaryB:subB
 * 平替专区「脱销 × 平替」明细：每组返回 平替点(价位相近/支型相同/口味相似) +
 * 平替款胀库(库存包数/可供天数) + 脱销天数(无数据源时 null)。
 * pairs 由前端 zoneGroups（primary + 首选 alternatives[0]）拼出。
 * 参数缺失/表未就绪时降级为空数组（前端只出正文、不渲染表）。
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
