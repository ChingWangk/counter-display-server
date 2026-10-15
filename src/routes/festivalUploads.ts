import { Router, Request, Response } from 'express';
import {
  isValidCustomerId,
  isValidFestivalId,
  listFestivalImages,
  submitFestivalImage,
  deleteOwnSubmission,
  UploadError,
} from '../services/festivalUploads';

/**
 * /api/festival-uploads — 节日专区客户投稿主题图(小程序侧)。
 *  GET    ?customer_id=&festival_id=              { mine(本人该节日投稿,含审核状态), shared(他人已通过的公共图) }
 *  POST   { customer_id, festival_id, image }     投稿一张(image = base64,JPG/PNG,≤8MB;每客户最多 20 张),进入审核
 *  DELETE ?customer_id=&id=                       撤回/删除本人的一张投稿
 * 审核接口见 routes/festivalReview.ts(/api/admin/festival-submissions,需后台令牌)。
 * 注意:POST 体积大,app.ts 里本路由挂在全局 express.json()(100kb 上限)之前,并单独放宽到 12mb。
 */
const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const customerId = req.query.customer_id;
  const festivalId = req.query.festival_id;
  if (!isValidCustomerId(customerId) || !isValidFestivalId(festivalId)) {
    res.status(400).json({ success: false, error: '缺少或非法的 customer_id / festival_id' });
    return;
  }
  try {
    const data = await listFestivalImages(customerId, festivalId);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[festival-uploads] 列举失败:', err);
    res.status(500).json({ success: false, error: '获取主题图失败' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  const { customer_id: customerId, festival_id: festivalId, image } =
    (req.body || {}) as { customer_id?: unknown; festival_id?: unknown; image?: unknown };
  if (!isValidCustomerId(customerId) || !isValidFestivalId(festivalId)) {
    res.status(400).json({ success: false, error: '缺少或非法的 customer_id / festival_id' });
    return;
  }
  if (typeof image !== 'string' || image.length === 0) {
    res.status(400).json({ success: false, error: '缺少图片内容' });
    return;
  }
  try {
    const saved = await submitFestivalImage(customerId, festivalId, image);
    res.json({ success: true, image: saved });
  } catch (err) {
    if (err instanceof UploadError) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    console.error('[festival-uploads] 保存失败:', err);
    res.status(500).json({ success: false, error: '图片保存失败' });
  }
});

router.delete('/', async (req: Request, res: Response) => {
  const customerId = req.query.customer_id;
  const id = Number(req.query.id);
  if (!isValidCustomerId(customerId) || !Number.isInteger(id) || id <= 0) {
    res.status(400).json({ success: false, error: '参数不完整' });
    return;
  }
  try {
    if (!(await deleteOwnSubmission(customerId, id))) {
      res.status(404).json({ success: false, error: '图片不存在' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[festival-uploads] 删除失败:', err);
    res.status(500).json({ success: false, error: '删除失败' });
  }
});

export default router;
