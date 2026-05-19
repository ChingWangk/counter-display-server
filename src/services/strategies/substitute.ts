import pool from '../../db';
import { RowDataPacket } from 'mysql2';

/**
 * 平替专区数据访问层：
 *  - getCustomerHasPos(customerId): 取 cust_info.has_pos，缺省时返回 false
 *  - fetchSubstituteRules(customerId, hasPos): 计算客户脱销规格 → Top N 平替候选的映射
 *
 * 设计原则：DB 调用集中在此文件，纯函数 classifySubstitute（zones.ts）只负责
 * 用 Map<spec_id_a, spec_id_b[]> 组装 ZoneGroup,便于单测。
 */

const TOP_N_SUBSTITUTES = 3;

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
 * 为客户挖掘脱销规格 → Top N 平替候选的映射。
 *
 * 数据来源:
 *  - hasPos=true:  cust_inventory 中 stock_qty=0 的规格作为脱销源 spec_id_a
 *  - hasPos=false: ref_yangpu_stockout 全表作为脱销源 spec_id_a
 *
 * 对每个 spec_id_a,从 ref_co_purchase_rules 取 target_type 含 'stockout' 的 Top N 推荐(rank_in_a ASC)。
 * 返回 Map<spec_id_a, spec_id_b[]>:value 是按 rank_in_a 升序的 spec_id_b 数组(最多 N 个)。
 *
 * 调用方(zones.ts classifySubstitute)负责:
 *   - 过滤 spec_id_b 必须在客户在售品规集合内
 *   - alternatives 至少 1 个在售才组队
 *
 * 任一阶段表缺失/数据为空时返回 Empty Map,不抛错,使专区静默退场。
 */
export async function fetchSubstituteRules(
  customerId: string,
  hasPos: boolean,
): Promise<Map<string, string[]>> {
  // 1. 取脱销源 spec_ids
  let stockoutIds: string[] = [];
  try {
    if (hasPos) {
      if (!customerId) return new Map();
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
      console.warn('[substitute] stockout table not ready, returning empty map');
      return new Map();
    }
    console.error('[substitute] fetch stockout error:', err);
    return new Map();
  }

  if (stockoutIds.length === 0) return new Map();

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
    const map = new Map<string, string[]>();
    for (const r of rows) {
      const arr = map.get(r.spec_id_a) || [];
      arr.push(r.spec_id_b);
      map.set(r.spec_id_a, arr);
    }
    return map;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[substitute] ref_co_purchase_rules not ready, returning empty map');
      return new Map();
    }
    console.error('[substitute] fetch substitute rules error:', err);
    return new Map();
  }
}
