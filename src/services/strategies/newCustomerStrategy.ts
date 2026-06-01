import pool from '../../db';
import { RowDataPacket } from 'mysql2';
import { Category } from '../../types';
import { sortCategories } from '../sortCategories';
import { categoryMap } from '../categoryCatalog';
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
 *  4. 资源匮乏（specCount > totalSlots）时过滤紧俏烟，但高价烟（price>600）保留
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
  if (withImages.length > ctx.totalSlots) {
    const hotSpecs = withImages.filter(c => c.is_hot && c.price <= HIGH_PRICE_PROTECT);
    if (hotSpecs.length > 0) {
      filteredHotSpecs = hotSpecs.map(c => ({ id: c.id, name: c.name }));
      const removeIds = new Set(hotSpecs.map(c => c.id));
      withImages = withImages.filter(c => !removeIds.has(c.id));
    }
  }

  return {
    specs: withImages,
    usedSpecIds,
    filteredHotSpecs,
  };
};
