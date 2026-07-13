import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

/**
 * 客户登录 / 密码维护路由。
 *
 * 数据源:cust_info.login_password（VARCHAR，初始默认 '111'，见 migratePassword.ts）。
 *  - POST /api/auth/login            客户编号 + 密码 → 校验，成功返回客户类型
 *  - POST /api/auth/change-password  客户自助改密（校验原密码）
 *  - POST /api/auth/reset-password   管理维护:重置为初始密码 '111'
 *
 * 安全说明(与《数据安全与陈列策略方法论说明》§1.3 路线图一致):
 *  - 当前密码为明文存储、reset 接口暂无管理员鉴权 —— 属规划中的加固项(P0)。
 *    生产上线应改为 bcrypt 哈希 + reset 接口置于 /admin 鉴权之后。
 */

const router = Router();

/** 初始密码:所有客户默认 '111'。 */
const DEFAULT_PASSWORD = '111';

interface AuthRow extends RowDataPacket {
  joined_at: string | Date | null;
  has_pos: number | null;
  login_password: string | null;
  customer_name: string | null;
}

/** 距今 N 个月之前的日期（按自然月），与 customerInfo/customerClass 保持一致口径。 */
function monthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

/** 由 joined_at 计算客户类型（入网 ≥ 3 个月 = regular，否则 new）。 */
function classify(joinedAt: string | Date | null): { customer_class: 'new' | 'regular'; joined_at: string | null } {
  if (!joinedAt) return { customer_class: 'new', joined_at: null };
  const j = new Date(joinedAt);
  if (isNaN(j.getTime())) return { customer_class: 'new', joined_at: null };
  return {
    customer_class: j <= monthsAgo(3) ? 'regular' : 'new',
    joined_at: j.toISOString().slice(0, 10),
  };
}

/**
 * POST /api/auth/login
 * body: { customer_id, password }
 * 成功:{ success:true, data:{ customer_id, customer_class, joined_at, has_pos, must_change_password } }
 * 失败:{ success:false, error }（密码错误 / 客户不存在为业务失败，HTTP 200；参数缺失 400；异常 500）
 */
router.post('/login', async (req: Request, res: Response) => {
  const customerId = String(req.body?.customer_id ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!customerId) {
    res.status(400).json({ success: false, error: '客户编号不能为空' });
    return;
  }
  if (!password) {
    res.status(400).json({ success: false, error: '请输入密码' });
    return;
  }

  try {
    const [rows] = await pool.execute<AuthRow[]>(
      'SELECT joined_at, has_pos, login_password, customer_name FROM cust_info WHERE customer_id = ?',
      [customerId],
    );

    if (rows.length === 0) {
      res.json({ success: false, error: '客户编号不存在，请核对' });
      return;
    }

    // 密码列可能为 NULL（历史行未回填）→ 视为初始密码 '111'
    const expected = rows[0].login_password ?? DEFAULT_PASSWORD;
    if (password !== expected) {
      res.json({ success: false, error: '密码错误' });
      return;
    }

    const c = classify(rows[0].joined_at);
    res.json({
      success: true,
      data: {
        customer_id: customerId,
        customer_class: c.customer_class,
        joined_at: c.joined_at,
        has_pos: Boolean(rows[0].has_pos),
        customer_name: rows[0].customer_name ?? null,  // 店名（用作机器人称呼 / 配置页展示）；无则 null
        must_change_password: expected === DEFAULT_PASSWORD,
      },
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    // cust_info 表未就绪（开发环境）:降级为"初始密码可进"，避免因表未建完全无法登录
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[auth] cust_info 表未就绪，降级为初始密码登录');
      if (password === DEFAULT_PASSWORD) {
        res.json({
          success: true,
          data: { customer_id: customerId, customer_class: 'new', joined_at: null, has_pos: false, customer_name: null, must_change_password: true },
        });
      } else {
        res.json({ success: false, error: '密码错误' });
      }
      return;
    }
    console.error('[auth] login error:', err);
    res.status(500).json({ success: false, error: '登录失败' });
  }
});

/**
 * POST /api/auth/change-password
 * body: { customer_id, old_password, new_password } —— 校验原密码后更新。
 */
router.post('/change-password', async (req: Request, res: Response) => {
  const customerId = String(req.body?.customer_id ?? '').trim();
  const oldPassword = String(req.body?.old_password ?? '');
  const newPassword = String(req.body?.new_password ?? '');
  if (!customerId) {
    res.status(400).json({ success: false, error: '客户编号不能为空' });
    return;
  }
  if (!newPassword) {
    res.status(400).json({ success: false, error: '新密码不能为空' });
    return;
  }
  if (newPassword.length > 64) {
    res.status(400).json({ success: false, error: '新密码长度不能超过 64 位' });
    return;
  }

  try {
    const [rows] = await pool.execute<AuthRow[]>(
      'SELECT login_password FROM cust_info WHERE customer_id = ?',
      [customerId],
    );
    if (rows.length === 0) {
      res.json({ success: false, error: '客户编号不存在' });
      return;
    }
    const expected = rows[0].login_password ?? DEFAULT_PASSWORD;
    if (oldPassword !== expected) {
      res.json({ success: false, error: '原密码错误' });
      return;
    }
    await pool.execute(
      'UPDATE cust_info SET login_password = ? WHERE customer_id = ?',
      [newPassword, customerId],
    );
    res.json({ success: true });
  } catch (err: unknown) {
    console.error('[auth] change-password error:', err);
    res.status(500).json({ success: false, error: '修改密码失败' });
  }
});

/**
 * POST /api/auth/reset-password
 * body: { customer_id } —— 管理维护:把该客户密码重置为初始密码 '111'。
 * 注意:当前无管理员鉴权（与全站现状一致），生产环境应置于 /admin 鉴权之后。
 */
router.post('/reset-password', async (req: Request, res: Response) => {
  const customerId = String(req.body?.customer_id ?? '').trim();
  if (!customerId) {
    res.status(400).json({ success: false, error: '客户编号不能为空' });
    return;
  }
  try {
    const [result] = await pool.execute<ResultSetHeader>(
      'UPDATE cust_info SET login_password = ? WHERE customer_id = ?',
      [DEFAULT_PASSWORD, customerId],
    );
    if (result.affectedRows === 0) {
      res.json({ success: false, error: '客户编号不存在' });
      return;
    }
    res.json({ success: true, password: DEFAULT_PASSWORD });
  } catch (err: unknown) {
    console.error('[auth] reset-password error:', err);
    res.status(500).json({ success: false, error: '重置密码失败' });
  }
});

export default router;
