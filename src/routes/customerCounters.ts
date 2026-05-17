import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface CounterRow extends RowDataPacket {
  customer_id: string;
  counter_id: string;
  type: 'front' | 'hanging' | 'back';
  length: number;
  levels: number;
  sort_order: number;
}

/** GET /api/customer-counters/:id — 返回客户的柜台配置
 *
 * 用于前端 counter-config 页面：用户输入客户编号后，
 * 自动从 cust_counters 表回填柜台列表（按 sort_order 排序）。
 *
 * Fallback：客户无柜台记录 → 返回空数组（让前端走"手工添加"流程）。
 */
router.get('/:id', async (req: Request, res: Response) => {
  const customerId = req.params.id;
  if (!customerId) {
    res.status(400).json({ success: false, error: '客户编号不能为空' });
    return;
  }

  try {
    const [rows] = await pool.execute<CounterRow[]>(
      `SELECT customer_id, counter_id, type, length, levels, sort_order
         FROM cust_counters
        WHERE customer_id = ?
        ORDER BY sort_order ASC`,
      [customerId]
    );

    res.json({
      success: true,
      counters: rows.map(r => ({
        id: r.counter_id,
        type: r.type,
        length: r.length,
        levels: r.levels,
        sortOrder: r.sort_order,
      })),
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[customer-counters] table not ready, returning empty');
      res.json({ success: true, counters: [] });
      return;
    }
    console.error('Query customer-counters error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
