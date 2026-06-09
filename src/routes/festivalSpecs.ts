import { Router, Request, Response } from 'express';
import { getExtendedCategoryMap } from '../services/categoryCatalog';
import { listFestivalSelectableSpecs } from '../services/strategies/festivalSeason';

/**
 * GET /api/festival-specs — 列出"可选节日商品"。
 * 范围 = 所有有 back-festival 图片素材的 spec(= 有商品编码的商品),供 zone-select 弹窗单选。
 * 返回 { id, name(商品名,缺则用编码), thumbUrl(首个变体礼盒图,相对路径) }[]。
 */
const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const extendedMap = await getExtendedCategoryMap();
    const specs = listFestivalSelectableSpecs(extendedMap);
    res.json({ success: true, specs });
  } catch (err) {
    console.error('[festival-specs] 列举失败:', err);
    res.status(500).json({ success: false, error: '获取节日商品列表失败' });
  }
});

export default router;
