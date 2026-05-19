import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface StockoutRow extends RowDataPacket {
  spec_id: string;
  spec_name: string | null;
  sellers_count: number;
  stockout_count: number;
  stockout_rate: string; // DECIMAL → string in mysql2
  snapshot_date: string;
}

/** GET /api/yangpu-stockout — 杨浦区脱销规格清单（挖掘产出）
 *
 * 口径：上季度卖过该规格的 POS 商户里，当前盘点为 0 的占比 > 30%（且 sellers_count ≥ 5）。
 * 主要用途：无 POS 客户分支用于品类决策（剔除/降权）。
 *
 * 查询参数：
 *  - min_rate 可选，默认不再过滤（库表已过滤）；传 0.5 等可二次收紧
 */
router.get('/', async (req: Request, res: Response) => {
  const minRate = Number(req.query.min_rate);
  const whereFilter =
    Number.isFinite(minRate) && minRate > 0 ? 'WHERE stockout_rate >= ?' : '';
  const params = Number.isFinite(minRate) && minRate > 0 ? [minRate] : [];

  try {
    const [rows] = await pool.execute<StockoutRow[]>(
      `SELECT spec_id, spec_name, sellers_count, stockout_count, stockout_rate, snapshot_date
         FROM ref_yangpu_stockout
         ${whereFilter}
        ORDER BY stockout_rate DESC, sellers_count DESC`,
      params,
    );

    res.json({
      success: true,
      stockouts: rows.map(r => ({
        spec_id: r.spec_id,
        spec_name: r.spec_name,
        sellers_count: r.sellers_count,
        stockout_count: r.stockout_count,
        stockout_rate: Number(r.stockout_rate),
        snapshot_date: r.snapshot_date,
      })),
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      res.json({ success: true, stockouts: [] });
      return;
    }
    console.error('Query yangpu-stockout error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
