import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface CoverageRow extends RowDataPacket {
  spec_id: string;
  spec_name: string;
  coverage_rate: string;
  snapshot_month: string;
}

/** GET /api/market-coverage — 铺市面率
 *
 * 查询参数：
 *  - spec_ids=110105,110106  仅返回指定 spec 的（逗号分隔，最多 100 个）
 *  - order=asc / desc        按 coverage_rate 排序（默认 asc — "短中细爆"专区使用，铺市从低到高）
 *  - limit=N                 限制返回行数
 *
 * 取最新 snapshot_month 数据。
 */
router.get('/', async (req: Request, res: Response) => {
  const specIdsParam = req.query.spec_ids as string | undefined;
  const order = ((req.query.order as string) || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const limit = Math.min(Number(req.query.limit) || 1000, 1000);

  let whereSpec = '';
  const params: string[] = [];
  if (specIdsParam) {
    const ids = specIdsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
    if (ids.length === 0) {
      res.json({ success: true, coverage: [] });
      return;
    }
    whereSpec = `AND spec_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }

  try {
    const [rows] = await pool.execute<CoverageRow[]>(
      `SELECT spec_id, spec_name, coverage_rate, snapshot_month
         FROM ref_market_coverage
        WHERE snapshot_month = (SELECT MAX(snapshot_month) FROM ref_market_coverage)
              ${whereSpec}
        ORDER BY coverage_rate ${order}
        LIMIT ${limit}`,
      params
    );

    res.json({
      success: true,
      coverage: rows.map(r => ({
        spec_id: r.spec_id,
        spec_name: r.spec_name,
        coverage_rate: Number(r.coverage_rate),
        snapshot_month: r.snapshot_month,
      })),
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      res.json({ success: true, coverage: [] });
      return;
    }
    console.error('Query market-coverage error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
