import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface FillRow extends RowDataPacket {
  spec_id: string;
  spec_name: string;
  fill_rate: string;
  snapshot_month: string;
}

/** GET /api/order-fill-rate — 订足率
 *
 * 同 market-coverage 接口设计：
 *  - spec_ids=...
 *  - order=desc (默认，"短中细爆"专区从高到低)
 *  - limit=N
 */
router.get('/', async (req: Request, res: Response) => {
  const specIdsParam = req.query.spec_ids as string | undefined;
  const order = ((req.query.order as string) || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const limit = Math.min(Number(req.query.limit) || 1000, 1000);

  let whereSpec = '';
  const params: string[] = [];
  if (specIdsParam) {
    const ids = specIdsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
    if (ids.length === 0) {
      res.json({ success: true, fill_rates: [] });
      return;
    }
    whereSpec = `AND spec_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }

  try {
    const [rows] = await pool.execute<FillRow[]>(
      `SELECT spec_id, spec_name, fill_rate, snapshot_month
         FROM ref_order_fill_rate
        WHERE snapshot_month = (SELECT MAX(snapshot_month) FROM ref_order_fill_rate)
              ${whereSpec}
        ORDER BY fill_rate ${order}
        LIMIT ${limit}`,
      params
    );

    res.json({
      success: true,
      fill_rates: rows.map(r => ({
        spec_id: r.spec_id,
        spec_name: r.spec_name,
        fill_rate: Number(r.fill_rate),
        snapshot_month: r.snapshot_month,
      })),
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      res.json({ success: true, fill_rates: [] });
      return;
    }
    console.error('Query order-fill-rate error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
