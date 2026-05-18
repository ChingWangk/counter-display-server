import { Category } from '../../types';
import { SpecInventoryInfo, ZoneSpec, ZoneClassification } from './types';

/**
 * 常规客户三个低成本专区分类器。
 * 纯函数：入参为只读数据结构，出参为新数组，无副作用，可独立单测。
 *
 * - classifySlowMoving：滞销夸夸角，stock_days ≥ 30 且 stock_qty ≥ 3
 * - classifyNostalgia： 怀旧专区，  is_delisted = true
 * - classifyNewProduct：尝鲜专区， launch_date 在窗口期（一/二类 24 月，其他 12 月）
 * - classifyZones：     一次性返回三专区结果，供 regularCustomerStrategy 使用
 *
 * 后续如需 平替 / 价签 / 节日 等专区，按相同函数签名追加，不影响已有签名。
 */

const SLOW_MOVING_DAYS = 30;
const SLOW_MOVING_QTY = 3;
const HIGH_TIER_NEW_MONTHS = 24;
const DEFAULT_NEW_MONTHS = 12;

const HIGH_TIER_VALUES = new Set(['一类', '二类']);

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

/** 滞销夸夸角：积压库存 ≥ 30 天且数量 ≥ 3 条的规格，按 stock_days 降序。 */
export function classifySlowMoving(
  specs: ReadonlyArray<Category>,
  inventoryById: ReadonlyMap<string, SpecInventoryInfo>,
): ZoneSpec[] {
  const result: ZoneSpec[] = [];
  for (const spec of specs) {
    const inv = inventoryById.get(spec.id);
    if (!inv) continue;
    if (inv.stock_days >= SLOW_MOVING_DAYS && inv.stock_qty >= SLOW_MOVING_QTY) {
      result.push({
        id: spec.id,
        name: spec.name,
        imageUrl: spec.imageUrl,
        stock_days: inv.stock_days,
        stock_qty: inv.stock_qty,
      });
    }
  }
  result.sort((a, b) => (b.stock_days ?? 0) - (a.stock_days ?? 0));
  return result;
}

/** 怀旧专区：is_delisted = true 的规格，按 name 字典序稳定排序。 */
export function classifyNostalgia(specs: ReadonlyArray<Category>): ZoneSpec[] {
  const result: ZoneSpec[] = [];
  for (const spec of specs) {
    if (spec.is_delisted !== true) continue;
    result.push({
      id: spec.id,
      name: spec.name,
      imageUrl: spec.imageUrl,
      successor_id: spec.successor_id ?? null,
    });
  }
  result.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return result;
}

/** 尝鲜专区：上市日期在窗口期（一/二类 24 月，其他 12 月）内的规格，按上市日期降序。 */
export function classifyNewProduct(
  specs: ReadonlyArray<Category>,
  now: Date = new Date(),
): ZoneSpec[] {
  const result: ZoneSpec[] = [];
  for (const spec of specs) {
    if (!spec.launch_date) continue;
    const launch = new Date(spec.launch_date);
    if (isNaN(launch.getTime())) continue;
    const months = monthsBetween(launch, now);
    if (months < 0) continue;  // 未来上市日期忽略
    const window = HIGH_TIER_VALUES.has(spec.tier ?? '') ? HIGH_TIER_NEW_MONTHS : DEFAULT_NEW_MONTHS;
    if (months <= window) {
      result.push({
        id: spec.id,
        name: spec.name,
        imageUrl: spec.imageUrl,
        launch_date: spec.launch_date,
      });
    }
  }
  result.sort((a, b) => (b.launch_date ?? '').localeCompare(a.launch_date ?? ''));
  return result;
}

/** 一次性运行三个分类器，便于 regularCustomerStrategy 调用。 */
export function classifyZones(
  specs: ReadonlyArray<Category>,
  inventoryById: ReadonlyMap<string, SpecInventoryInfo>,
  now: Date = new Date(),
): ZoneClassification {
  return {
    slowMoving: classifySlowMoving(specs, inventoryById),
    nostalgia: classifyNostalgia(specs),
    newProduct: classifyNewProduct(specs, now),
  };
}
