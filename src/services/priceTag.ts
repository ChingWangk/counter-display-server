import pool from '../db';
import { RowDataPacket } from 'mysql2';

/**
 * 价签白名单数据访问：根据客户的 has_pos 标记，从 ref_yangpu_avg_price 取该客户应显示价签的规格。
 *
 * 业务口径：
 *  - has_pos=true（安装 POS 的客户）→ show_for_pos = 1 的规格（约 7 个高价规格）
 *  - has_pos=false（未安装 POS）   → show_for_nopos = 1 的规格（约 3 个）
 *
 * 取最新 snapshot_month。返回 Map<spec_id, avg_price>。
 *
 * 表/数据缺失时返回空 Map，使价签静默退场，不影响出图。
 */
export async function getPriceTagMap(hasPos: boolean): Promise<Map<string, number>> {
  const flagColumn = hasPos ? 'show_for_pos' : 'show_for_nopos';
  try {
    const [rows] = await pool.execute<PriceTagRow[]>(
      `
      SELECT spec_id, avg_price
        FROM ref_yangpu_avg_price
       WHERE snapshot_month = (SELECT MAX(snapshot_month) FROM ref_yangpu_avg_price)
         AND ${flagColumn} = 1
      `,
    );
    const map = new Map<string, number>();
    for (const r of rows) {
      const price = Number(r.avg_price);
      if (Number.isFinite(price)) map.set(r.spec_id, price);
    }
    return map;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[priceTag] ref_yangpu_avg_price table not ready, returning empty map');
      return new Map();
    }
    console.error('[priceTag] getPriceTagMap error:', err);
    return new Map();
  }
}

interface PriceTagRow extends RowDataPacket {
  spec_id: string;
  avg_price: string;  // DECIMAL → string in mysql2
}

// ---- 价签助手「价格对照表」：区域常卖价 × 客户当前售价 ----

/** 对照表一行：某白名单规格的区域常卖价 vs 该客户当前售价。 */
export interface PriceCompareRow {
  spec_id: string;
  spec_name: string;
  region_price: number;       // 区域常卖价（ref_yangpu_avg_price.avg_price）
  my_price: number | null;    // 客户当前售价（cust_spec_price；查不到 = null = "暂无记录"）
  below: boolean;             // my_price 有值且 < region_price（售价偏低、可上调）
}

export interface PriceComparison {
  rows: PriceCompareRow[];    // 该客户 has_pos 白名单下的全部规格（缺售价的也在列，my_price=null）
  belowCount: number;         // 售价偏低（可上调）的规格数
  snapshotMonth: string | null;
}

interface RegionRow extends RowDataPacket {
  spec_id: string;
  spec_name: string;
  avg_price: string;
}

interface CustPriceRow extends RowDataPacket {
  spec_id: string;
  price: string;
  snapshot_month: string;
}

/**
 * 取某客户的价格对照表：ref_yangpu_avg_price（区域价，按 has_pos 白名单）左连 cust_spec_price（客户售价）。
 * 白名单规格全列出；查不到客户售价的 my_price=null（前端标"暂无记录"）。
 *
 * 任一表缺失时降级：区域表缺 → 返回空表；客户售价表缺 → 全部 my_price=null（只显示区域价）。
 */
export async function getCustomerPriceComparison(
  customerId: string,
  hasPos: boolean,
): Promise<PriceComparison> {
  const flagColumn = hasPos ? 'show_for_pos' : 'show_for_nopos';
  try {
    const [regionRows] = await pool.execute<RegionRow[]>(
      `
      SELECT spec_id, spec_name, avg_price
        FROM ref_yangpu_avg_price
       WHERE snapshot_month = (SELECT MAX(snapshot_month) FROM ref_yangpu_avg_price)
         AND ${flagColumn} = 1
       ORDER BY avg_price DESC
      `,
    );
    if (regionRows.length === 0) return { rows: [], belowCount: 0, snapshotMonth: null };

    // 客户售价（最新月）——表未建时视为"全部暂无记录"，不报错
    const myPriceById = new Map<string, number>();
    let snapshotMonth: string | null = null;
    try {
      const [priceRows] = await pool.execute<CustPriceRow[]>(
        `
        SELECT spec_id, price, snapshot_month
          FROM cust_spec_price
         WHERE customer_id = ?
           AND snapshot_month = (SELECT MAX(snapshot_month) FROM cust_spec_price WHERE customer_id = ?)
        `,
        [customerId, customerId],
      );
      for (const r of priceRows) {
        const p = Number(r.price);
        if (Number.isFinite(p)) myPriceById.set(r.spec_id, p);
        snapshotMonth = r.snapshot_month;
      }
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code !== 'ER_NO_SUCH_TABLE') throw err;
      console.warn('[priceTag] cust_spec_price table not ready, all my_price = null');
    }

    const rows: PriceCompareRow[] = regionRows.map(r => {
      const region = Number(r.avg_price);
      const mine = myPriceById.has(r.spec_id) ? myPriceById.get(r.spec_id)! : null;
      const below = mine !== null && mine < region;
      return { spec_id: r.spec_id, spec_name: r.spec_name, region_price: region, my_price: mine, below };
    });
    const belowCount = rows.filter(r => r.below).length;
    return { rows, belowCount, snapshotMonth };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[priceTag] ref_yangpu_avg_price table not ready, empty comparison');
      return { rows: [], belowCount: 0, snapshotMonth: null };
    }
    console.error('[priceTag] getCustomerPriceComparison error:', err);
    return { rows: [], belowCount: 0, snapshotMonth: null };
  }
}
