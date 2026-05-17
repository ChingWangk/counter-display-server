import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface PriceRow extends RowDataPacket {
  spec_id: string;
  spec_name: string;
  avg_price: string;  // DECIMAL → string in mysql2
  show_for_pos: number;
  show_for_nopos: number;
  snapshot_month: string;
}

/** GET /api/yangpu-avg-price — 杨浦区平均售价 + 价签白名单
 *
 * 查询参数：
 *  - has_pos=1 仅返回 POS 客户应显示的（7 个规格）
 *  - has_pos=0 仅返回无 POS 客户应显示的（前 3 个）
 *  - 不传    全部返回
 *
 * 取最新 snapshot_month。
 */
router.get('/', async (req: Request, res: Response) => {
  const hasPos = req.query.has_pos;
  let whereFilter = '';
  if (hasPos === '1') whereFilter = 'AND show_for_pos = 1';
  else if (hasPos === '0') whereFilter = 'AND show_for_nopos = 1';

  try {
    const [rows] = await pool.execute<PriceRow[]>(
      `SELECT spec_id, spec_name, avg_price, show_for_pos, show_for_nopos, snapshot_month
         FROM ref_yangpu_avg_price
        WHERE snapshot_month = (SELECT MAX(snapshot_month) FROM ref_yangpu_avg_price)
              ${whereFilter}
        ORDER BY avg_price DESC`
    );

    res.json({
      success: true,
      prices: rows.map(r => ({
        spec_id: r.spec_id,
        spec_name: r.spec_name,
        avg_price: Number(r.avg_price),
        show_for_pos: Boolean(r.show_for_pos),
        show_for_nopos: Boolean(r.show_for_nopos),
        snapshot_month: r.snapshot_month,
      })),
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      res.json({ success: true, prices: [] });
      return;
    }
    console.error('Query yangpu-avg-price error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
