import pool from '../db';
import { RowDataPacket } from 'mysql2';
import { getExtendedCategoryMap } from './categoryCatalog';

/**
 * 平替专区「脱销 × 平替」明细取数（供 agent-chat 陈列说明的两张表）：
 *  - 每个脱销规格的「脱销天数」（若库里有该口径列则取，无则 null → 前端降级为 '—'/折叠进正文）
 *  - 每组平替款的「胀库数据」（库存包数 stock_qty + 可供天数 stock_days，取该客户最新快照）
 *  - 每组的「平替点」：价位相近 / 支型相同 / 口味相似（价位与支型都不同时取口味相似）
 *
 * 设计红线（见 [[pricetag-bot-data-source]] / [[industrial-coop-detail-source]]）：
 *   只用真实数据，任一列缺失即降级为 null，绝不硬拼/编造。整表/整列缺失也不抛错，返回空/局部即可。
 */

/** 前端传入的一组脱销→平替对（平替款取该组排序后的首选 alternatives[0]）。 */
export interface SubstitutePair {
  primaryId: string;
  subId: string;
}

/** 门店「全部脱销规格」明细的一行（供《脱销明细表》，来自 cust_stockout 全量，不限于有平替的组）。 */
export interface StockoutListItem {
  specId: string;
  /** 规格名（catalog 有则用名，缺失极少数用 spec_id 兜底，保证脱销总数不被漏计）。 */
  name: string;
  stockoutDays: number;
}

/** 单组明细（渲染就绪的数值层，字符串化在前端做）。 */
export interface SubstituteDetail {
  primaryId: string;
  subId: string;
  /** 平替点：'价位相近' | '支型相同' | '口味相似'。 */
  reason: '价位相近' | '支型相同' | '口味相似';
  /** 脱销天数：暂无数据源时为 null（前端降级）。 */
  stockoutDays: number | null;
  /** 平替款胀库：库存包数；缺则 null。 */
  subStockQty: number | null;
  /** 平替款胀库：可供天数（stock_days，越大越"胀"）；缺则 null。 */
  subStockDays: number | null;
}

/** 价位相近阈值：两规格基础价（元/条）相对差 ≤ 15% 视为"价位相近"。 */
const PRICE_CLOSE_RATIO = 0.15;

interface InvRow extends RowDataPacket {
  spec_id: string;
  stock_qty: number | null;
  stock_days: number | null;
}

interface StockoutDaysRow extends RowDataPacket {
  spec_id: string;
  stockout_days: number | null;
}

/** cust_stockout 表列名（受信常量，非用户输入）。 */
const STOCKOUT_TABLE = 'cust_stockout';

/** 平替点判定：价位相近优先，其次支型相同，两者都不满足 → 口味相似（承接行为相似的兜底口径）。 */
function decideReason(
  primaryPrice: number | null | undefined,
  subPrice: number | null | undefined,
  primaryPack: string | null | undefined,
  subPack: string | null | undefined,
): SubstituteDetail['reason'] {
  if (
    primaryPrice != null && subPrice != null && primaryPrice > 0 &&
    Math.abs(subPrice - primaryPrice) / primaryPrice <= PRICE_CLOSE_RATIO
  ) {
    return '价位相近';
  }
  if (primaryPack && subPack && primaryPack === subPack) {
    return '支型相同';
  }
  return '口味相似';
}

/**
 * 取该客户各 spec 最新快照的库存（stock_qty / stock_days）。
 * cust_inventory 表未就绪或无该客户数据 → 空 Map（前端胀库列降级）。
 */
async function fetchLatestInventory(
  customerId: string,
  specIds: string[],
): Promise<Map<string, { stockQty: number | null; stockDays: number | null }>> {
  const map = new Map<string, { stockQty: number | null; stockDays: number | null }>();
  if (!customerId || specIds.length === 0) return map;
  try {
    const placeholders = specIds.map(() => '?').join(',');
    const [rows] = await pool.execute<InvRow[]>(
      `
      SELECT t.spec_id, t.stock_qty, t.stock_days
      FROM cust_inventory t
      INNER JOIN (
        SELECT spec_id, MAX(snapshot_date) AS max_date
        FROM cust_inventory
        WHERE customer_id = ? AND spec_id IN (${placeholders})
        GROUP BY spec_id
      ) m ON t.spec_id = m.spec_id AND t.snapshot_date = m.max_date
      WHERE t.customer_id = ?
      `,
      [customerId, ...specIds, customerId],
    );
    for (const r of rows) {
      map.set(r.spec_id, {
        stockQty: r.stock_qty == null ? null : Number(r.stock_qty),
        stockDays: r.stock_days == null ? null : Number(r.stock_days),
      });
    }
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== 'ER_NO_SUCH_TABLE') {
      console.error('[substituteDetail] fetch inventory error:', err);
    }
  }
  return map;
}

/**
 * 取脱销规格的「脱销天数」，读 cust_stockout（POS 日结算出的当前脱销明细，见 compute_stockout_days.py）。
 * 表未就绪（ER_NO_SUCH_TABLE）→ 空 Map，脱销天数视为无数据源静默降级（前端折叠掉天数表）。
 */
async function fetchStockoutDays(
  customerId: string,
  specIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!customerId || specIds.length === 0) return map;
  try {
    const placeholders = specIds.map(() => '?').join(',');
    const [rows] = await pool.execute<StockoutDaysRow[]>(
      `SELECT spec_id, stockout_days FROM ${STOCKOUT_TABLE}
        WHERE customer_id = ? AND spec_id IN (${placeholders})`,
      [customerId, ...specIds],
    );
    for (const r of rows) {
      if (r.stockout_days != null) map.set(r.spec_id, Number(r.stockout_days));
    }
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== 'ER_NO_SUCH_TABLE') {
      console.error('[substituteDetail] fetch stockout_days error:', err);
    }
  }
  return map;
}

/**
 * 取该门店「全部当前脱销规格」明细（cust_stockout 全量），供《脱销明细表》。
 *
 * 关键：这张表反映的是**门店真实脱销面**（"近一个月脱销 N 个规格"），与"有没有配到平替"无关——
 * 所以它 **不** 走 zoneGroups（那只是能配平替的子集），而是直接读 cust_stockout 全量。
 * 规格名从 catalog 取；极少数 catalog 查无名的用 spec_id 兜底，避免脱销总数被漏计。
 * 表未就绪（ER_NO_SUCH_TABLE）或无该客户数据 → 空数组（前端整表折叠，只出正文）。
 * 按脱销天数降序（脱得越久越靠前，越该提醒）。
 */
export async function getCustomerStockoutList(customerId: string): Promise<StockoutListItem[]> {
  if (!customerId) return [];
  let rows: StockoutDaysRow[] = [];
  try {
    const [r] = await pool.execute<StockoutDaysRow[]>(
      `SELECT spec_id, stockout_days FROM ${STOCKOUT_TABLE} WHERE customer_id = ?`,
      [customerId],
    );
    rows = r;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== 'ER_NO_SUCH_TABLE') {
      console.error('[substituteDetail] fetch stockout list error:', err);
    }
    return [];
  }
  const catMap = await getExtendedCategoryMap();
  const list: StockoutListItem[] = [];
  for (const r of rows) {
    if (r.stockout_days == null) continue;
    const cat = catMap.get(r.spec_id);
    list.push({
      specId: r.spec_id,
      name: cat ? cat.name : r.spec_id,
      stockoutDays: Number(r.stockout_days),
    });
  }
  list.sort((a, b) => b.stockoutDays - a.stockoutDays);
  return list;
}

/**
 * 组装平替明细。pairs 由前端（zoneGroups：primary + 首选 alternatives[0]）传入，
 * 后端只补齐价位/支型判定与库存，避免重算专区分组。
 */
export async function getSubstituteDetails(
  customerId: string,
  pairs: SubstitutePair[],
): Promise<SubstituteDetail[]> {
  if (pairs.length === 0) return [];

  const catMap = await getExtendedCategoryMap();
  const primaryIds = pairs.map(p => p.primaryId);
  const subIds = pairs.map(p => p.subId);

  const [invMap, stockoutDaysMap] = await Promise.all([
    fetchLatestInventory(customerId, subIds),
    fetchStockoutDays(customerId, primaryIds),
  ]);

  return pairs.map(({ primaryId, subId }) => {
    const primary = catMap.get(primaryId);
    const sub = catMap.get(subId);
    const inv = invMap.get(subId);
    return {
      primaryId,
      subId,
      reason: decideReason(primary?.price, sub?.price, primary?.pack_type, sub?.pack_type),
      stockoutDays: stockoutDaysMap.has(primaryId) ? stockoutDaysMap.get(primaryId)! : null,
      subStockQty: inv ? inv.stockQty : null,
      subStockDays: inv ? inv.stockDays : null,
    };
  });
}
