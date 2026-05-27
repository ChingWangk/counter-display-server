import pool from '../../db';
import { RowDataPacket } from 'mysql2';

/**
 * 沪产专区数据访问层。
 *
 * 第二排数据源:ref_local_brand_growth(spec_id, year, quarter, yoy_rate)。
 * 按最新 (year, quarter) 取一组 (spec_id → yoy_rate) Map。
 *
 * 表不存在 / 暂无数据时静默返回空 Map,classifyLocalShanghai 会因此让 row2Specs 为 [],
 * 仅 row1(沪产新品)生效。
 */

interface GrowthRow extends RowDataPacket {
  spec_id: string;
  yoy_rate: string | null;
}

interface LatestRow extends RowDataPacket {
  year: number;
  quarter: number;
}

/** 拉取 ref_local_brand_growth 最新季度的 spec_id → yoy_rate 映射。 */
export async function fetchLatestLocalBrandGrowth(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const [latest] = await pool.execute<LatestRow[]>(
      `SELECT year, quarter FROM ref_local_brand_growth
        ORDER BY year DESC, quarter DESC LIMIT 1`
    );
    if (latest.length === 0) return map;
    const { year, quarter } = latest[0];

    const [rows] = await pool.execute<GrowthRow[]>(
      `SELECT spec_id, yoy_rate FROM ref_local_brand_growth
        WHERE year = ? AND quarter = ?`,
      [year, quarter],
    );
    for (const r of rows) {
      if (r.yoy_rate === null) continue;
      const n = Number(r.yoy_rate);
      if (!isNaN(n)) map.set(r.spec_id, n);
    }
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') return map;
    console.error('fetchLatestLocalBrandGrowth error:', err);
  }
  return map;
}
