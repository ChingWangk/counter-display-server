import pool from '../../db';
import { RowDataPacket } from 'mysql2';
import { Category } from '../../types';
import { sortCategories } from '../sortCategories';
import { categoryMap } from '../categoryCatalog';
import { FORCED_HOT_SPECS_BY_CUSTOMER, MONTHLY_HOT_SPEC_IDS } from './monthlyHotSpecs';
import { SelectionContext, SelectionResult, StrategyFn, ValidationError } from './types';

/** 高价烟保护阈值：批发价 > 600 元/条 的紧俏烟即便资源不足也保留（门店刚需） */
const HIGH_PRICE_PROTECT = 600;

interface InventoryRow extends RowDataPacket {
  spec_id: string;
}

/**
 * 新客户智能推荐（入网时间 < 3 个月）。
 *
 * 行为与归档版 generate.ts 的 smart 分支一致 —— 只是数据源从 customer_specs(旧表)迁到
 * cust_inventory(常规客户也读此表)。原本归档版依赖一次性 SQL 把 cust_inventory 回填到
 * customer_specs.spec_detail,新客户落库时回填没跟上就会触发"后台无数据"误报。
 *
 *  1. 客户编号必填
 *  2. 从 cust_inventory 拉该客户的所有 spec_id(取每个 spec 最新一次盘库,与 regular 一致)
 *  3. 按 sortCategories 排序（集团→省外→外烟）
 *  4. 资源匮乏（specCount > totalSlots）时过滤当月货源属性表里的紧俏烟，但高价烟（price>600）保留
 *
 * 与 regularCustomerStrategy 的差异(刻意保持):
 *  - 不做专区分类、不读 ref_co_purchase_rules / dim_category_ext 等
 *  - 不返回 zonePlacements / inventoryById,前端不进入 zone-select
 */
export const newCustomerStrategy: StrategyFn = async (ctx: SelectionContext): Promise<SelectionResult> => {
  if (!ctx.customerId) {
    throw new ValidationError('智能推荐需要客户代码，请先填写');
  }

  // 取每个 spec 的最新库存快照(只要 spec_id;库存数量、天数对新客户场景不参与决策)
  const [rows] = await pool.execute<InventoryRow[]>(
    `
    SELECT DISTINCT t.spec_id
    FROM cust_inventory t
    INNER JOIN (
      SELECT spec_id, MAX(snapshot_date) AS max_date
      FROM cust_inventory
      WHERE customer_id = ?
      GROUP BY spec_id
    ) m ON t.spec_id = m.spec_id AND t.snapshot_date = m.max_date
    WHERE t.customer_id = ?
    `,
    [ctx.customerId, ctx.customerId]
  );

  if (rows.length === 0) {
    throw new ValidationError('后台无数据，请检查所填客户代码是否正确');
  }

  const ids: string[] = rows.map((r: InventoryRow) => r.spec_id);
  const usedSpecIds = new Set(ids);
  const pool_ = ids
    .map(id => categoryMap.get(id))
    .filter((c): c is Category => c !== undefined);

  let withImages = sortCategories(pool_);

  let filteredHotSpecs: { id: string; name: string }[] | undefined;
  // 紧俏剔除只在「品规超容」(规格数 > 陈列位)时发生;不超容一律不剔除、不出明细,
  // 否则会出现"货少柜宽(双包)却提示紧俏暂缓"的矛盾。
  const forcedHot = FORCED_HOT_SPECS_BY_CUSTOMER[ctx.customerId];
  if (withImages.length > ctx.totalSlots && forcedHot) {
    // 该客户固定剔除清单:超容时整份剔除并列入明细,不走下方按货源属性表的剔除
    const removeIds = new Set(forcedHot);
    filteredHotSpecs = forcedHot.map(id => ({ id, name: categoryMap.get(id)?.name ?? id }));
    withImages = withImages.filter(c => !removeIds.has(c.id));
    for (const id of forcedHot) usedSpecIds.delete(id);
  } else if (withImages.length > ctx.totalSlots) {
    // 紧俏口径取当月货源属性表(MONTHLY_HOT_SPEC_IDS),不用 categories.json 的 is_hot,
    // 保证暂缓的规格与结果页剔除明细完全一致。
    // 只暂缓「刚好让规格数降到陈列位数」所需的个数(从排序最靠后的紧俏烟开始),
    // 剔除后恰好铺满(标准排满),不会因剔除过多掉进单包扩距/双包档。
    const overflow = withImages.length - ctx.totalSlots;
    const hotSpecs = withImages.filter(c => MONTHLY_HOT_SPEC_IDS.has(c.id) && c.price <= HIGH_PRICE_PROTECT);
    const removeIds = new Set(hotSpecs.slice(-overflow).map(c => c.id));
    if (removeIds.size > 0) {
      filteredHotSpecs = hotSpecs.filter(c => removeIds.has(c.id)).map(c => ({ id: c.id, name: c.name }));
      withImages = withImages.filter(c => !removeIds.has(c.id));
    }
  }

  return {
    specs: withImages,
    usedSpecIds,
    filteredHotSpecs,
  };
};
