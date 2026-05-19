import { Category } from '../../types';
import {
  SpecInventoryInfo,
  ZoneSpec,
  ZoneClassification,
  ZoneAssignment,
  ZonePlacement,
  ZoneId,
  ZONE_META,
  ZONE_PRIORITY_ORDER,
} from './types';

/**
 * 4 个低成本专区分类器。
 * 纯函数：入参为只读数据结构，出参为新数组，无副作用，可独立单测。
 *
 * - classifyIndustrialCoop：工商共育，is_industrial_coop = true
 * - classifySlowMoving：滞销夸夸角，stock_days ≥ 30 且 stock_qty ≥ 3
 * - classifyNostalgia： 怀旧专区，  is_delisted = true
 * - classifyNewProduct：尝鲜专区， launch_date 在窗口期（一/二类 24 月，其他 12 月）
 * - classifyZones：     一次性返回四专区结果（已按优先级 dedupe）
 *
 * Dedupe 规则：一个 spec 最多归属一个专区,按优先级 industrialCoop > slowMoving > nostalgia > newProduct 先到先得。
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

/** 工商共育：is_industrial_coop = true 的规格，按品类排序保持稳定。 */
export function classifyIndustrialCoop(specs: ReadonlyArray<Category>): ZoneSpec[] {
  const result: ZoneSpec[] = [];
  for (const spec of specs) {
    if (spec.is_industrial_coop !== true) continue;
    result.push({
      id: spec.id,
      name: spec.name,
      imageUrl: spec.imageUrl,
    });
  }
  // 保持入参顺序（caller 通常已经 sortCategories 过）
  return result;
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

/**
 * 一次性运行 4 个分类器并按优先级 dedupe。
 *
 * 优先级顺序:industrialCoop > slowMoving > nostalgia > newProduct。
 * 同一 spec 命中多个专区时,仅保留在第一个命中的专区中。
 *
 * inventoryById 缺省或为空时,slowMoving 自然返回 []。其它专区不依赖 inventory。
 */
export function classifyZones(
  specs: ReadonlyArray<Category>,
  inventoryById: ReadonlyMap<string, SpecInventoryInfo> = new Map(),
  now: Date = new Date(),
): ZoneClassification {
  const used = new Set<string>();
  const industrialCoop = classifyIndustrialCoop(specs);
  industrialCoop.forEach(s => used.add(s.id));

  const slowSrc = specs.filter(s => !used.has(s.id));
  const slowMoving = classifySlowMoving(slowSrc, inventoryById);
  slowMoving.forEach(s => used.add(s.id));

  const nostalgiaSrc = specs.filter(s => !used.has(s.id));
  const nostalgia = classifyNostalgia(nostalgiaSrc);
  nostalgia.forEach(s => used.add(s.id));

  const newProductSrc = specs.filter(s => !used.has(s.id));
  const newProduct = classifyNewProduct(newProductSrc, now);

  return { industrialCoop, slowMoving, nostalgia, newProduct };
}

/**
 * 把 ZoneClassification + 用户的 ZoneAssignment[] 落位为 ZonePlacement[]。
 *
 * sortedSourceSpecs 应是 sortCategories 排好序的完整 Category 列表(允许重复——
 * manual 模式下用户对同一品类的多次选择会保留)。filter 后,zone specs 保留原有顺序与重复。
 *
 * 注意:zone specs 同时保留在 sortedSourceSpecs(常规陈列池)中,不再从中扣除——同一规格
 * 会在 zone 行(带色条)与常规行各出现一次,体现"专区品规也出现在专区外的常规陈列区"。
 */
export function buildZonePlacements(
  classification: ZoneClassification,
  assignments: ReadonlyArray<ZoneAssignment>,
  sortedSourceSpecs: ReadonlyArray<Category>,
): ZonePlacement[] {
  // 建立 zone_id → 命中的 spec_id 集合
  const zoneIdToSet = new Map<ZoneId, Set<string>>();
  for (const zoneId of ZONE_PRIORITY_ORDER) {
    zoneIdToSet.set(zoneId, new Set(classification[zoneId].map(s => s.id)));
  }

  const placements: ZonePlacement[] = [];
  for (const assignment of assignments) {
    const ids = zoneIdToSet.get(assignment.zone_id);
    if (!ids || ids.size === 0) continue;
    const specs = sortedSourceSpecs.filter(c => ids.has(c.id));
    if (specs.length === 0) continue;
    const meta = ZONE_META[assignment.zone_id];
    placements.push({
      zoneId: assignment.zone_id,
      counterId: assignment.counter_id,
      rowCount: assignment.row_count,
      specs,
      barColor: meta.barColor,
      priorityRank: meta.priorityRank,
      specCount: specs.length,
    });
  }
  return placements;
}
