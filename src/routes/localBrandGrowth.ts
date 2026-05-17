import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface GrowthRow extends RowDataPacket {
  spec_id: string;
  spec_name: string;
  year: number;
  quarter: number;
  yoy_rate: string | null;
}

/** GET /api/local-brand-growth — 沪产烟同比增长率（沪产专区第二排）
 *
 * 查询参数：
 *  - year quarter  指定季度（默认最新）
 *  - order=desc    按 yoy_rate 排序（默认降序）
 */
router.get('/', async (req: Request, res: Response) => {
  const yearParam = req.query.year as string | undefined;
  const quarterParam = req.query.quarter as string | undefined;
  const order = ((req.query.order as string) || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  try {
    let year: number;
    let quarter: number;
    if (yearParam && quarterParam) {
      year = Number(yearParam);
      quarter = Number(quarterParam);
    } else {
      const [latest] = await pool.execute<RowDataPacket[]>(
        `SELECT year, quarter FROM ref_local_brand_growth
          ORDER BY year DESC, quarter DESC LIMIT 1`
      );
      if (latest.length === 0) {
        res.json({ success: true, year: null, quarter: null, growth: [] });
        return;
      }
      year = latest[0].year;
      quarter = latest[0].quarter;
    }

    const [rows] = await pool.execute<GrowthRow[]>(
      `SELECT spec_id, spec_name, year, quarter, yoy_rate
         FROM ref_local_brand_growth
        WHERE year = ? AND quarter = ?
        ORDER BY (yoy_rate IS NULL), yoy_rate ${order}`,
      [year, quarter]
    );

    res.json({
      success: true,
      year,
      quarter,
      growth: rows.map(r => ({
        spec_id: r.spec_id,
        spec_name: r.spec_name,
        yoy_rate: r.yoy_rate === null ? null : Number(r.yoy_rate),
      })),
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      res.json({ success: true, year: null, quarter: null, growth: [] });
      return;
    }
    console.error('Query local-brand-growth error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
