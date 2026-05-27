import pool from '../../db';
import { RowDataPacket } from 'mysql2';

/**
 * 短中细爆组合专区数据访问层。
 *
 *  - ref_market_coverage(spec_id, snapshot_month, coverage_rate)  → fetchLatestMarketCoverage()
 *  - ref_order_fill_rate(spec_id, snapshot_month, fill_rate)      → fetchLatestOrderFillRate()
 *
 * 各自取最新 snapshot_month 的一组 (spec_id → 数值) Map。表不存在 / 暂无数据时静默返回空 Map,
 * classifyShortSlimBead 因此自然返回 []。
 */

interface RateRow extends RowDataPacket {
  spec_id: string;
  rate: string | null;
}

async function fetchLatestRateMap(
  table: string,
  rateColumn: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    // 取最新 snapshot_month + 该月所有 (spec_id, rate)。一次 SQL,简单。
    const [rows] = await pool.execute<RateRow[]>(
      `SELECT spec_id, ${rateColumn} AS rate FROM ${table}
        WHERE snapshot_month = (SELECT MAX(snapshot_month) FROM ${table})`
    );
    for (const r of rows) {
      if (r.rate === null) continue;
      const n = Number(r.rate);
      if (!isNaN(n)) map.set(r.spec_id, n);
    }
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') return map;
    console.error(`fetchLatestRateMap(${table}) error:`, err);
  }
  return map;
}

/** ref_market_coverage 最新月份的 spec_id → coverage_rate 映射(0~1 区间)。 */
export function fetchLatestMarketCoverage(): Promise<Map<string, number>> {
  return fetchLatestRateMap('ref_market_coverage', 'coverage_rate');
}

/** ref_order_fill_rate 最新月份的 spec_id → fill_rate 映射(0~1 区间)。 */
export function fetchLatestOrderFillRate(): Promise<Map<string, number>> {
  return fetchLatestRateMap('ref_order_fill_rate', 'fill_rate');
}
