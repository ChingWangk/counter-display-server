import pool from '../db';
import { RowDataPacket } from 'mysql2';
import { getExtendedCategoryMap } from './categoryCatalog';

/**
 * 平替专区《脱销平替对照表》明细取数（供 agent-chat 陈列说明）：
 *  - 每组平替款的「胀库数据」（库存包数 stock_qty + 可供天数 stock_days，取该客户最新快照）
 *  - 每组的「平替点」：价位相近 / 支型相同 / 口味相似（价位与支型都不同时取口味相似）
 *
 * 设计红线（见 [[substitute-detail-source]] / [[pricetag-bot-data-source]]）：
 *   只用真实数据，任一列缺失即降级为 null，绝不硬拼/编造。整表/整列缺失也不抛错，返回空/局部即可。
 *
 * 已下线：门店全量脱销清单 getCustomerStockoutList + 每组脱销天数（均读 cust_stockout）。
 *   《脱销明细表》连同它的"脱销天数"列一并撤掉，故此处不再依赖 cust_stockout。
 */

/** 前端传入的一组脱销→平替对（平替款取该组排序后的首选 alternatives[0]）。 */
export interface SubstitutePair {
  primaryId: string;
  subId: string;
}

/** 单组明细（渲染就绪的数值层，字符串化在前端做）。 */
export interface SubstituteDetail {
  primaryId: string;
  subId: string;
  /** 平替点：'价位相近' | '支型相同' | '口味相似'。 */
  reason: '价位相近' | '支型相同' | '口味相似';
  /** 平替款胀库：库存包数；缺则 null。 */
  subStockQty: number | null;
  /** 平替款胀库：可供天数（stock_days，越大越"胀"）；缺失**或为哨兵值**时 null（此时看 subNoSales）。 */
  subStockDays: number | null;
  /** true = 该平替款统计窗口内日均销量≤0（压根没动销）→ 可供天数无意义，前端讲"近期无动销"。 */
  subNoSales: boolean;
}

/**
 * cust_inventory.stock_days 的哨兵值。取数脚本 build_customer_inventory_from_pos.py::stock_days()：
 *   库存>0 且日均销量≤0（统计窗口内一包没卖）→ 记 9999，**不是真实天数**，只是"除不动、算不出"的占位。
 * 全表约 13% 的行是这个值，直接显示会变成"可供 9999 天"这种明显不可信的数字。
 */
const NO_SALES_STOCK_DAYS = 9999;

/** 价位相近阈值：两规格基础价（元/条）相对差 ≤ 15% 视为"价位相近"。 */
const PRICE_CLOSE_RATIO = 0.15;

interface InvRow extends RowDataPacket {
  spec_id: string;
  stock_qty: number | null;
  stock_days: number | null;
}

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
 * 组装平替明细。pairs 由前端（zoneGroups：primary + 首选 alternatives[0]）传入，
 * 后端只补齐价位/支型判定与库存，避免重算专区分组。
 */
export async function getSubstituteDetails(
  customerId: string,
  pairs: SubstitutePair[],
): Promise<SubstituteDetail[]> {
  if (pairs.length === 0) return [];

  const catMap = await getExtendedCategoryMap();
  const subIds = pairs.map(p => p.subId);
  const invMap = await fetchLatestInventory(customerId, subIds);

  const out: SubstituteDetail[] = [];
  for (const { primaryId, subId } of pairs) {
    const primary = catMap.get(primaryId);
    const sub = catMap.get(subId);
    // catalog(categories.json)查无此码的规格直接忽略：多为雪茄等不在本课题范围内的品类,
    // 无名无价无支型,平替点只能瞎猜、表里也只能显示一串代码。宁可不出这行。
    if (!primary || !sub) continue;
    const inv = invMap.get(subId);
    // 哨兵 9999 不是天数,置 null 并改用 subNoSales 表达"没动销"——这本就是最强的胀库信号,
    // 比一个假装精确的 9999 更有用,也更经得起店主质疑。
    const rawDays = inv ? inv.stockDays : null;
    const noSales = rawDays === NO_SALES_STOCK_DAYS;
    out.push({
      primaryId,
      subId,
      reason: decideReason(primary.price, sub.price, primary.pack_type, sub.pack_type),
      subStockQty: inv ? inv.stockQty : null,
      subStockDays: noSales ? null : rawDays,
      subNoSales: noSales,
    });
  }
  return out;
}
