import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface RankRow extends RowDataPacket {
  spec_id: string;
  spec_name: string;
  year: number;
  quarter: number;
  wholesale_qty: number;
  rank_in_quarter: number;
}

/** GET /api/wholesale-rank — 高价烟季度批发量排名（礼盒精品专区）
 *
 * 查询参数：
 *  - year=2026 quarter=1   指定季度（默认最新）
 *  - top=20                返回 Top N（默认全部）
 */
router.get('/', async (req: Request, res: Response) => {
  const yearParam = req.query.year as string | undefined;
  const quarterParam = req.query.quarter as string | undefined;
  const top = Math.min(Number(req.query.top) || 1000, 1000);

  try {
    let year: number;
    let quarter: number;
    if (yearParam && quarterParam) {
      year = Number(yearParam);
      quarter = Number(quarterParam);
    } else {
      const [latest] = await pool.execute<RowDataPacket[]>(
        `SELECT year, quarter FROM ref_quarterly_wholesale_rank
          ORDER BY year DESC, quarter DESC LIMIT 1`
      );
      if (latest.length === 0) {
        res.json({ success: true, year: null, quarter: null, ranks: [] });
        return;
      }
      year = latest[0].year;
      quarter = latest[0].quarter;
    }

    const [rows] = await pool.execute<RankRow[]>(
      `SELECT spec_id, spec_name, year, quarter, wholesale_qty, rank_in_quarter
         FROM ref_quarterly_wholesale_rank
        WHERE year = ? AND quarter = ?
        ORDER BY rank_in_quarter ASC
        LIMIT ${top}`,
      [year, quarter]
    );

    res.json({
      success: true,
      year,
      quarter,
      ranks: rows.map(r => ({
        spec_id: r.spec_id,
        spec_name: r.spec_name,
        wholesale_qty: r.wholesale_qty,
        rank: r.rank_in_quarter,
      })),
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      res.json({ success: true, year: null, quarter: null, ranks: [] });
      return;
    }
    console.error('Query wholesale-rank error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
