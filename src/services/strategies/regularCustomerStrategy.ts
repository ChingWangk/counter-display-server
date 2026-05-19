import pool from '../../db';
import { RowDataPacket } from 'mysql2';
import { Category } from '../../types';
import { sortCategories } from '../sortCategories';
import { getExtendedCategoryMap } from '../categoryCatalog';
import { classifyZones, buildZonePlacements } from './zones';
import {
  SelectionContext,
  SelectionResult,
  StrategyFn,
  ValidationError,
  SpecInventoryInfo,
} from './types';

/** 高价烟保护阈值：批发价 > 600 元/条 的紧俏烟即便资源不足也保留 */
const HIGH_PRICE_PROTECT = 600;

interface InventoryRow extends RowDataPacket {
  spec_id: string;
  stock_qty: number;
  stock_days: number;
  snapshot_date: string | Date;
}

/**
 * 常规客户智能推荐（入网时间 ≥ 3 个月）。
 *
 * 演进路线：
 *  - 第 1 步【已完成】：作为 newCustomerStrategy 的别名，行为一致。
 *  - 第 2 步【已完成】：脱离 customer_specs 依赖，直接读 cust_inventory（取每个 spec 最新
 *    snapshot_date），把"客户在售品规"作为陈列候选集；同时把 stock_qty/stock_days 通过
 *    inventoryById 一并回传，供后续专区策略使用。
 *  - 第 3 步【已完成】：滞销夸夸角 / 怀旧专区 / 尝鲜专区 三个低成本分类器（zones.ts）。
 *  - 第 4 步【当前】：新增工商共育专区,并按用户在 zone-select 选的 zoneAssignments 把 zone specs
 *    从常规陈列区扣除,返回 zonePlacements 供 imageGen 顶部行渲染。
 *
 * 隔离原则：本文件的任何变化都不应回流到 newCustomerStrategy；新增依赖（cust_inventory、
 * ref_co_purchase_rules 等）只在本模块内部使用。
 */
export const regularCustomerStrategy: StrategyFn = async (ctx: SelectionContext): Promise<SelectionResult> => {
  if (!ctx.customerId) {
    throw new ValidationError('智能推荐需要客户代码，请先填写');
  }

  // 取每个 spec 的最新库存快照：cust_inventory PK 为 (customer_id, spec_id, snapshot_date)，
  // 同一 spec 可能有多次盘库记录，此处只要最新一次
  const [rows] = await pool.execute<InventoryRow[]>(
    `
    SELECT t.spec_id, t.stock_qty, t.stock_days, t.snapshot_date
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
    throw new ValidationError('该常规客户暂无库存数据，请确认数据已导入');
  }

  // 构建 spec_id → 最新库存快照
  const inventoryById = new Map<string, SpecInventoryInfo>();
  const ids: string[] = [];
  for (const r of rows) {
    const snapshotStr = r.snapshot_date instanceof Date
      ? r.snapshot_date.toISOString().slice(0, 10)
      : String(r.snapshot_date).slice(0, 10);
    inventoryById.set(r.spec_id, {
      spec_id: r.spec_id,
      stock_qty: Number(r.stock_qty),
      stock_days: Number(r.stock_days),
      snapshot_date: snapshotStr,
    });
    ids.push(r.spec_id);
  }

  const usedSpecIds = new Set(ids);

  // 通过 categoryMap 转换为 Category 列表（过滤未收录的 id）
  // 使用扩展版（含 dim_category_ext 字段），供 classifyZones 判断 is_delisted / launch_date / tier / is_industrial_coop
  const extendedCategoryMap = await getExtendedCategoryMap();
  const carriedSpecs = ids
    .map(id => extendedCategoryMap.get(id))
    .filter((c): c is Category => c !== undefined);

  let withImages = sortCategories(carriedSpecs);

  // 资源不足时过滤紧俏烟，高价烟保护
  let filteredHotSpecs: { id: string; name: string }[] | undefined;
  if (withImages.length > ctx.totalSlots) {
    const hotSpecs = withImages.filter(c => c.is_hot && c.price <= HIGH_PRICE_PROTECT);
    if (hotSpecs.length > 0) {
      filteredHotSpecs = hotSpecs.map(c => ({ id: c.id, name: c.name }));
      const removeIds = new Set(hotSpecs.map(c => c.id));
      withImages = withImages.filter(c => !removeIds.has(c.id));
    }
  }

  // 专区分类(已优先级 dedupe):工商共育 / 滞销 / 怀旧 / 尝鲜
  // 在 hot 过滤后运行,让滞销专区基于"实际陈列范围"
  const classification = classifyZones(withImages, inventoryById);

  // 根据用户的 zoneAssignments 把 zone specs 从常规陈列扣除
  const zonePlacements = buildZonePlacements(classification, ctx.zoneAssignments ?? [], withImages);
  const zoneSpecIds = new Set(zonePlacements.flatMap(p => p.specs.map(s => s.id)));
  withImages = withImages.filter(c => !zoneSpecIds.has(c.id));

  return {
    specs: withImages,
    usedSpecIds,
    filteredHotSpecs,
    inventoryById,
    zonePlacements,
  };
};
