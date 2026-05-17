import pool from '../../db';
import { RowDataPacket } from 'mysql2';
import { Category } from '../../types';
import { sortCategories } from '../sortCategories';
import { categoryMap } from '../categoryCatalog';
import { SelectionContext, SelectionResult, StrategyFn, ValidationError } from './types';

/** 高价烟保护阈值：批发价 > 600 元/条 的紧俏烟即便资源不足也保留（门店刚需） */
const HIGH_PRICE_PROTECT = 600;

/**
 * 新客户智能推荐（入网时间 < 3 个月）。
 *
 * 行为与重构前 generate.ts 的 smart 分支完全一致：
 *  1. 客户编号必填
 *  2. 从 customer_specs.spec_detail 读取该客户的主营品规 id 列表
 *  3. 按 sortCategories 排序（集团→省外→外烟）
 *  4. 资源匮乏（specCount > totalSlots）时过滤紧俏烟，但高价烟（price>600）保留
 *
 * 数据依赖：customer_specs 表（旧表，已通过一次性 SQL 从 cust_inventory 回填）。
 */
export const newCustomerStrategy: StrategyFn = async (ctx: SelectionContext): Promise<SelectionResult> => {
  if (!ctx.customerId) {
    throw new ValidationError('智能推荐需要客户代码，请先填写');
  }

  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT spec_detail FROM customer_specs WHERE customer_id = ?',
    [ctx.customerId]
  );

  if (!rows.length || !rows[0].spec_detail) {
    throw new ValidationError('后台无数据，请检查所填客户代码是否正确');
  }

  const ids: string[] = rows[0].spec_detail.split(',').map((s: string) => s.trim());
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
