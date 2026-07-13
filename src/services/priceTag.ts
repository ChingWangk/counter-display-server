import pool from '../db';
import { RowDataPacket } from 'mysql2';

/*
 * 价签口径（负责人拍板）：价签只贴在"客户售价 < 区域常卖价"的待升价规格上，印的是区域常卖价=建议上调到的目标价。
 * 白名单按 has_pos 取 ref_yangpu_avg_price 的 show_for_pos(≈7) / show_for_nopos(≈3) 子集，再逐客户过滤偏低规格。
 * 判定与取数统一走下方 getCustomerPriceComparison —— 出图贴签用它、价签助手对照表也用它，保证图/话术同源。
 */

// ---- 价签助手「待升价对照表」：区域常卖价 × 客户当前售价（仅偏低规格） ----

/** 对照表一行：某待升价规格的区域常卖价 vs 该客户当前售价（仅收录售价 < 区域价的规格）。 */
export interface PriceCompareRow {
  spec_id: string;
  spec_name: string;
  region_price: number;       // 区域常卖价（ref_yangpu_avg_price.avg_price；建议上调到的目标价）
  my_price: number;           // 客户当前售价（cust_spec_price；一定 < region_price）
  below: true;                // 恒为 true（对照表只列偏低规格，保留字段供前端标红/兼容）
}

export interface PriceComparison {
  rows: PriceCompareRow[];    // 只含"卖得比区域常卖价低"的待升价规格；无则为空数组
  belowCount: number;         // = rows.length，售价偏低（可上调）的规格数
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
 * 取某客户的"待升价对照表"：ref_yangpu_avg_price（区域价，按 has_pos 白名单）连 cust_spec_price（客户售价），
 * 只保留客户售价 < 区域常卖价的规格（核心是提醒老板把这几款调高，卖价已达标/查不到售价的一律不列）。
 *
 * 任一表缺失时降级：区域表缺 → 空表；客户售价表缺 → 无从判定偏低 → 空表（绝不臆造"卖低了"）。
 * rows 为空即代表"该客户没有需要升价的规格"，调用方据此决定不出价签、不弹价签助手。
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

    // 客户售价（最新月）——表未建时 myPriceById 为空 → 无从判定偏低 → 最终空表，不报错
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
      console.warn('[priceTag] cust_spec_price table not ready, comparison degrades to empty');
    }

    // 只保留"客户售价 < 区域常卖价"的待升价规格；卖价达标或查不到售价的直接丢弃。
    const rows: PriceCompareRow[] = [];
    for (const r of regionRows) {
      const region = Number(r.avg_price);
      const mine = myPriceById.get(r.spec_id);
      if (mine === undefined || !(mine < region)) continue;
      rows.push({ spec_id: r.spec_id, spec_name: r.spec_name, region_price: region, my_price: mine, below: true });
    }
    return { rows, belowCount: rows.length, snapshotMonth };
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
