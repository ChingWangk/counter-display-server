import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();

interface CustomerSpecRow extends RowDataPacket {
  customer_id: string;
  spec_count: number;
  spec_detail: string | null;
  updated_at: string;
}

/** GET /api/customer-specs/:id — 查询单个客户规格 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const [rows] = await pool.execute<CustomerSpecRow[]>(
      'SELECT * FROM customer_specs WHERE customer_id = ?',
      [req.params.id]
    );
    if (rows.length === 0) {
      res.json({ success: true, data: null });
      return;
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('Query customer_specs error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

/** GET /api/customer-specs — 查询全部客户 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool.execute<CustomerSpecRow[]>(
      'SELECT * FROM customer_specs ORDER BY updated_at DESC'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('List customer_specs error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

/** POST /api/customer-specs — 新增或更新客户规格（upsert） */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { customer_id, spec_count, spec_detail } = req.body;
    if (!customer_id) {
      res.status(400).json({ success: false, error: 'customer_id 不能为空' });
      return;
    }

    await pool.execute<ResultSetHeader>(
      `INSERT INTO customer_specs (customer_id, spec_count, spec_detail)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE spec_count = VALUES(spec_count), spec_detail = VALUES(spec_detail)`,
      [customer_id, spec_count || 0, spec_detail || null]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Upsert customer_specs error:', err);
    res.status(500).json({ success: false, error: '保存失败' });
  }
});

/** DELETE /api/customer-specs/:id — 删除客户规格 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await pool.execute<ResultSetHeader>(
      'DELETE FROM customer_specs WHERE customer_id = ?',
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Delete customer_specs error:', err);
    res.status(500).json({ success: false, error: '删除失败' });
  }
});

export default router;
