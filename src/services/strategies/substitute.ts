import pool from '../../db';
import { RowDataPacket } from 'mysql2';

/**
 * 平替专区数据访问层：
 *  - getCustomerHasPos(customerId): 取 cust_info.has_pos，缺省时返回 false
 *  - fetchSubstituteSpecIds(customerId, hasPos): 计算客户脱销规格的 Top N 平替候选
 *
 * 设计原则：DB 调用集中在此文件，纯函数 classifySubstitute（zones.ts）只负责
 * 用 ReadonlySet<string> 做过滤，便于单测。
 */

const TOP_N_SUBSTITUTES = 5;

interface InventoryStockoutRow extends RowDataPacket {
  spec_id: string;
}

interface YangpuStockoutRow extends RowDataPacket {
  spec_id: string;
}

interface SubstituteRuleRow extends RowDataPacket {
  spec_id_a: string;
  spec_id_b: string;
  rank_in_a: number;
}

interface HasPosRow extends RowDataPacket {
  has_pos: number | null;
}

/** 查 cust_info.has_pos。表/字段缺失或客户不存在时返回 false（视为无 POS）。 */
export async function getCustomerHasPos(customerId: string): Promise<boolean> {
  if (!customerId) return false;
  try {
    const [rows] = await pool.execute<HasPosRow[]>(
      'SELECT has_pos FROM cust_info WHERE customer_id = ?',
      [customerId],
    );
    if (rows.length === 0) return false;
    return Boolean(rows[0].has_pos);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[substitute] cust_info table not ready, default has_pos=false');
      return false;
    }
    console.error('[substitute] getCustomerHasPos error:', err);
    return false;
  }
}

/**
 * 为客户挖掘平替候选 spec_id 集合。
 *
 * 数据来源:
 *  - hasPos=true:  cust_inventory 中 stock_qty=0 的规格作为脱销源
 *  - hasPos=false: ref_yangpu_stockout 全表作为脱销源
 *
 * 对每个脱销源,从 ref_co_purchase_rules 取 target_type 含 'stockout' 的 Top N 推荐(rank_in_a ASC)。
 * 返回所有候选 spec_id_b 的合并 Set。调用方负责把此 Set 与 customer 在售品规集合做交集。
 *
 * 任一阶段表缺失/数据为空时返回 Empty Set,不抛错,使专区静默退场。
 */
export async function fetchSubstituteSpecIds(
  customerId: string,
  hasPos: boolean,
): Promise<Set<string>> {
  // 1. 取脱销源 spec_ids
  let stockoutIds: string[] = [];
  try {
    if (hasPos) {
      if (!customerId) return new Set();
      const [rows] = await pool.execute<InventoryStockoutRow[]>(
        `
        SELECT t.spec_id
        FROM cust_inventory t
        INNER JOIN (
          SELECT spec_id, MAX(snapshot_date) AS max_date
          FROM cust_inventory
          WHERE customer_id = ?
          GROUP BY spec_id
        ) m ON t.spec_id = m.spec_id AND t.snapshot_date = m.max_date
        WHERE t.customer_id = ? AND t.stock_qty = 0
        `,
        [customerId, customerId],
      );
      stockoutIds = rows.map(r => r.spec_id);
    } else {
      const [rows] = await pool.execute<YangpuStockoutRow[]>(
        'SELECT spec_id FROM ref_yangpu_stockout',
      );
      stockoutIds = rows.map(r => r.spec_id);
    }
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[substitute] stockout table not ready, returning empty set');
      return new Set();
    }
    console.error('[substitute] fetch stockout error:', err);
    return new Set();
  }

  if (stockoutIds.length === 0) return new Set();

  // 2. 对每个脱销源批量取 substitute 候选(target_type 含 stockout, 取 Top N)
  try {
    const placeholders = stockoutIds.map(() => '?').join(',');
    const [rows] = await pool.execute<SubstituteRuleRow[]>(
      `
      SELECT spec_id_a, spec_id_b, rank_in_a
      FROM ref_co_purchase_rules
      WHERE spec_id_a IN (${placeholders})
        AND FIND_IN_SET('stockout', target_type) > 0
        AND rank_in_a <= ?
      ORDER BY spec_id_a, rank_in_a
      `,
      [...stockoutIds, TOP_N_SUBSTITUTES],
    );
    return new Set(rows.map(r => r.spec_id_b));
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[substitute] ref_co_purchase_rules not ready, returning empty set');
      return new Set();
    }
    console.error('[substitute] fetch substitute rules error:', err);
    return new Set();
  }
}
