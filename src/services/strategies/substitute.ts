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

/**
 * 候选池大小:从 ref_co_purchase_rules 拉取的每个脱销规格 Top N 候选。
 *
 * 这是"原始推荐池"的大小,业务层(zones.ts classifySubstitute)会在该池内
 * 按价格/产地/支型/库存等业务维度二次排序后选取 Top 2 作为最终展示。
 * 池过小 → 二次排序无空间;过大 → SQL 拉取浪费。20 是经验值,可调。
 */
const CANDIDATE_POOL_SIZE = 20;

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
 * 为客户挖掘脱销规格 → 候选平替池(每个 spec_id_a 最多 CANDIDATE_POOL_SIZE 个候选)。
 *
 * 数据来源:
 *  - hasPos=true:  cust_stockout 表(POS 日结算出的当前脱销)作为脱销源 spec_id_a(唯一源,见 fetchPosStockoutIds)
 *  - hasPos=false: ref_yangpu_stockout 全表作为脱销源 spec_id_a
 *
 * 对每个 spec_id_a,从 ref_co_purchase_rules 取 target_type 含 'stockout' 的 Top N 候选(rank_in_a ASC)。
 * 返回 Map<spec_id_a, spec_id_b[]>:value 是按 rank_in_a 升序的候选池(最多 CANDIDATE_POOL_SIZE 个)。
 *
 * 调用方(zones.ts classifySubstitute)负责:
 *   - 过滤 spec_id_b 必须在客户在售品规集合内(stock_qty > 0)
 *   - 业务排序(价格、产地、支型、库存)并选 Top 2
 *   - 候选不足时整组淘汰
 *
 * 任一阶段表缺失/数据为空时返回 Empty Map,不抛错,使专区静默退场。
 */
interface StockoutIdRow extends RowDataPacket {
  spec_id: string;
}

/**
 * POS 客户当前脱销 spec_ids：**唯一数据源 = cust_stockout**（POS 日结算出，精确、带天数，
 * 与陈列说明《脱销明细表》同源）。表未就绪（ER_NO_SUCH_TABLE）或该客户 0 行 → 返回空，
 * 平替专区据此静默退场。
 *
 * ⚠️ 不再回退 cust_inventory 月度快照 stock_qty=0：那会把「未被 POS 判定为当前脱销」的规格
 * 混进专区（这些规格在 cust_stockout 里查无记录 → 前端脱销天数取不到显示 '—'，且与《脱销明细表》
 * 不一致）。单一数据源保证：专区绿框组合 = 陈列图裁图 = 《脱销明细表》三者恒一致，
 * 绝不出现「cust_stockout 未记录却被判为脱销」的规格。
 */
async function fetchPosStockoutIds(customerId: string): Promise<string[]> {
  try {
    const [rows] = await pool.execute<StockoutIdRow[]>(
      'SELECT spec_id FROM cust_stockout WHERE customer_id = ?',
      [customerId],
    );
    return rows.map(r => r.spec_id);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[substitute] cust_stockout 表未就绪 → 平替专区本轮静默退场（不回退月度库存，避免混入未记录脱销规格）');
      return [];
    }
    throw err;  // 其它错误上抛给 fetchSubstituteRules 外层统一降级
  }
}

/**
 * 近一周脱销规格集（供平替专区派生的"脱销主规格"判定）：读 cust_recent_stockout 表
 * （POS 日结算出，窗口 [L-6, L] 内出现过 <=0，含已回补，见 cust_recent_stockout_table.sql）。
 *
 * 返回 Set<spec_id>；表未就绪（ER_NO_SUCH_TABLE）返回 **null** —— 调用方据此回退旧口径
 * （cust_inventory 月度快照 stock_qty==0），保证新表导入前行为不回归。该客户 0 行则返回空 Set
 * （POS 客户确实近一周无脱销，不应回退）。
 */
export async function fetchRecentStockoutIds(customerId: string): Promise<Set<string> | null> {
  if (!customerId) return null;
  try {
    const [rows] = await pool.execute<StockoutIdRow[]>(
      'SELECT spec_id FROM cust_recent_stockout WHERE customer_id = ?',
      [customerId],
    );
    return new Set(rows.map(r => r.spec_id));
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[substitute] cust_recent_stockout 表未就绪 → 平替脱销判定回退月度库存 stock_qty==0');
      return null;
    }
    throw err;
  }
}

export async function fetchSubstituteRules(
  customerId: string,
  hasPos: boolean,
): Promise<Map<string, string[]>> {
  // 1. 取脱销源 spec_ids
  let stockoutIds: string[] = [];
  try {
    if (hasPos) {
      if (!customerId) return new Map();
      // POS 客户的"当前脱销"以 cust_stockout 为准（POS 日结算出，已剔除从未经销/退市/非当前0，且带脱销天数），
      // 保证专区选出的脱销规格与陈列说明《脱销明细表》的脱销天数完全一致（不会出现"脱销但天数取不到"）。
      stockoutIds = await fetchPosStockoutIds(customerId);
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
      [...stockoutIds, CANDIDATE_POOL_SIZE],
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
