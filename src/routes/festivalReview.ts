import { Router, Request, Response } from 'express';
import {
  isValidFestivalId,
  listSubmissionsForReview,
  countSubmissionsByStatus,
  reviewSubmission,
  deleteSubmissionById,
  SubmissionStatus,
} from '../services/festivalUploads';

/**
 * /api/admin/festival-submissions — 节日主题图投稿审核(后台管理平台用,app.ts 挂载处经 adminAuth 校验令牌)。
 *  GET    ?status=pending|approved|rejected|all   列表(缺省 pending)+ 各状态计数
 *  POST   /:id/review { action:'approve'|'reject', reason?, festival_id? }   通过(可改节日标签)/ 驳回(附原因)
 *  DELETE /:id                                    彻底删除(记录 + 文件)
 */
const router = Router();

const STATUSES = new Set(['pending', 'approved', 'rejected', 'all']);

router.get('/', async (req: Request, res: Response) => {
  const s = typeof req.query.status === 'string' && STATUSES.has(req.query.status) ? req.query.status : 'pending';
  try {
    const [items, counts] = await Promise.all([
      listSubmissionsForReview(s as SubmissionStatus | 'all'),
      countSubmissionsByStatus(),
    ]);
    res.json({ success: true, items, counts });
  } catch (err) {
    console.error('[festival-review] 列举失败:', err);
    res.status(500).json({ success: false, error: '获取投稿列表失败' });
  }
});

router.post('/:id/review', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { action, reason, festival_id: festivalId } =
    (req.body || {}) as { action?: unknown; reason?: unknown; festival_id?: unknown };
  if (!Number.isInteger(id) || id <= 0 || (action !== 'approve' && action !== 'reject')) {
    res.status(400).json({ success: false, error: '参数不合法' });
    return;
  }
  if (festivalId !== undefined && festivalId !== '' && !isValidFestivalId(festivalId)) {
    res.status(400).json({ success: false, error: '节日标签不合法' });
    return;
  }
  try {
    const ok = await reviewSubmission(id, action, {
      reason: typeof reason === 'string' ? reason.trim() : undefined,
      festivalId: isValidFestivalId(festivalId) ? festivalId : undefined,
    });
    if (!ok) {
      res.status(404).json({ success: false, error: '投稿不存在' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[festival-review] 审核失败:', err);
    res.status(500).json({ success: false, error: '审核失败' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ success: false, error: '参数不合法' });
    return;
  }
  try {
    if (!(await deleteSubmissionById(id))) {
      res.status(404).json({ success: false, error: '投稿不存在' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[festival-review] 删除失败:', err);
    res.status(500).json({ success: false, error: '删除失败' });
  }
});

export default router;
