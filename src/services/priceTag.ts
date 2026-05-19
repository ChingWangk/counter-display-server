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
