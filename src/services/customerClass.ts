import pool from '../db';
import { RowDataPacket } from 'mysql2';

interface JoinedAtRow extends RowDataPacket {
  joined_at: string | Date | null;
}

export type CustomerClass = 'new' | 'regular';

/** 距今 N 个月之前的日期（按自然月） */
function monthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

/**
 * 根据 cust_info.joined_at 判定客户类型：
 *  - 入网时间 ≥ 3 个月：'regular'
 *  - 入网时间 < 3 个月，或表/记录缺失：'new'（fallback，不抛错）
 *
 * 路由层在选品时调用，决定走 newCustomerStrategy 还是 regularCustomerStrategy。
 */
export async function getCustomerClass(customerId: string): Promise<CustomerClass> {
  if (!customerId) return 'new';
  try {
    const [rows] = await pool.execute<JoinedAtRow[]>(
      'SELECT joined_at FROM cust_info WHERE customer_id = ?',
      [customerId]
    );
    if (rows.length === 0 || !rows[0].joined_at) return 'new';
    const joinedAt = new Date(rows[0].joined_at);
    const cutoff = monthsAgo(3);
    return joinedAt <= cutoff ? 'regular' : 'new';
  } catch (err: unknown) {
    // cust_info 表尚未建立时 MySQL 报 ER_NO_SUCH_TABLE (1146)
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') return 'new';
    throw err;
  }
}
