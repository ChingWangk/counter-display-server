import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface CustomerInfoRow extends RowDataPacket {
  joined_at: string | Date | null;
  has_pos: number | null;
}

/** 距今 N 个月之前的日期（按自然月） */
function monthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

/** GET /api/customer-info/:id — 返回客户类型 + POS 标记
 *
 * 判定逻辑：
 *  - 查 cust_info.joined_at（入网时间）、has_pos（POS 标记）
 *  - 与"当前日期 - 3 个月"比较：joined_at 早于该值 → 'regular'，否则 → 'new'
 *  - has_pos：1 → 该客户安装 POS 收银终端，价签显示策略走 POS 白名单；0 → 走非 POS 白名单
 *
 * Fallback（数据未就绪时）：
 *  - cust_info 表不存在 或 该客户无记录 → 默认 'new' + has_pos=false 并打 warn 日志
 *
 * 后续：cust_info 表正式建好并导入客户数据后，未匹配应当返回 404 / 错误。
 */
router.get('/:id', async (req: Request, res: Response) => {
  const customerId = req.params.id;
  if (!customerId) {
    res.status(400).json({ success: false, error: '客户编号不能为空' });
    return;
  }

  try {
    const [rows] = await pool.execute<CustomerInfoRow[]>(
      'SELECT joined_at, has_pos FROM cust_info WHERE customer_id = ?',
      [customerId]
    );

    if (rows.length === 0 || !rows[0].joined_at) {
      console.warn(`[customer-info] no joined_at for ${customerId}, defaulting to 'new'`);
      res.json({
        success: true,
        data: {
          customer_id: customerId,
          customer_class: 'new',
          joined_at: null,
          has_pos: false,
        },
      });
      return;
    }

    const joinedAt = new Date(rows[0].joined_at);
    const cutoff = monthsAgo(3);
    const customerClass = joinedAt <= cutoff ? 'regular' : 'new';

    res.json({
      success: true,
      data: {
        customer_id: customerId,
        customer_class: customerClass,
        joined_at: joinedAt.toISOString().slice(0, 10),
        has_pos: Boolean(rows[0].has_pos),
      },
    });
  } catch (err: unknown) {
    // cust_info 表尚未建立时 MySQL 报 ER_NO_SUCH_TABLE (1146)
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn(`[customer-info] cust_info table not ready, defaulting to 'new'`);
      res.json({
        success: true,
        data: { customer_id: customerId, customer_class: 'new', joined_at: null, has_pos: false },
      });
      return;
    }
    console.error('Query customer-info error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
