import { Router, Request, Response } from 'express';
import { getUpgradeDetails, UpgradePair } from '../services/upgradeDetail';

const router = Router();

/**
 * GET /api/upgrade-detail?pairs=oldA:upA,oldB:upB
 * 产品升级「组合明细」：每组返回 老品/升级款零售价、每包多赚、升级桥梁(品牌/支型/口味)、结构档位。
 * pairs 由前端 zoneGroups（primary=老品 + 首选 alternatives[0]=升级款）拼出。
 * 参数缺失/表未就绪 → 空数组（前端只出正文、不渲染表）。
 */
router.get('/', async (req: Request, res: Response) => {
  const raw = String(req.query.pairs || '').trim();
  const pairs: UpgradePair[] = raw
    ? raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => {
          const [oldId, upId] = s.split(':').map(x => x.trim());
          return { oldId, upId };
        })
        .filter(p => p.oldId && p.upId)
    : [];

  try {
    const details = await getUpgradeDetails(pairs);
    res.json({ success: true, details });
  } catch (err) {
    console.error('upgrade-detail error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
