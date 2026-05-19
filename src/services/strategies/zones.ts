import { Category } from '../../types';
import {
  SpecInventoryInfo,
  ZoneSpec,
  ZoneGroup,
  ZoneClassification,
  ZoneAssignment,
  ZonePlacement,
  ZonePlacementGroup,
  ZoneId,
  ZONE_META,
  ZONE_PRIORITY_ORDER,
} from './types';

/**
 * 5 个低成本专区分类器。
 * 纯函数：入参为只读数据结构，出参为新数组，无副作用，可独立单测。
 *
 * 展示模式分两类:
 *  - single  : 单品陈列(每包紧贴),工商共育 / 滞销夸夸角 / 尝鲜专区
 *  - grouped : 分组陈列(主规格双倍宽 + Top N 替代规格紧随),平替专区 / 怀旧专区
 *
 * - classifyIndustrialCoop: 工商共育,is_industrial_coop = true                            → ZoneSpec[]
 * - classifySubstitute:    平替专区, 脱销→Top N 平替组合(alternatives 必须在客户在售)    → ZoneGroup[]
 * - classifySlowMoving:    滞销夸夸角,stock_days ≥ 30 且 stock_qty ≥ 3                    → ZoneSpec[]
 * - classifyNostalgia:     怀旧专区, is_delisted = true && successor 在客户在售          → ZoneGroup[]
 * - classifyNewProduct:    尝鲜专区, launch_date 在窗口期(一/二类 24 月,其他 12 月)      → ZoneSpec[]
 * - classifyZones:         一次性返回五专区结果(已按 primary id 优先级 dedupe)
 *
 * Dedupe 规则:一个 spec 最多作为 primary 归属一个专区,按优先级
 * industrialCoop > substitute > slowMoving > nostalgia > newProduct 先到先得。
 * 分组专区的 alternatives 不参与 dedupe(允许跨专区出现)。
 */

const SLOW_MOVING_DAYS = 30;
const SLOW_MOVING_QTY = 3;
const HIGH_TIER_NEW_MONTHS = 24;
const DEFAULT_NEW_MONTHS = 12;

const HIGH_TIER_VALUES = new Set(['一类', '二类']);

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

function toZoneSpec(c: Category): ZoneSpec {
  return {
    id: c.id,
    name: c.name,
    imageUrl: c.imageUrl,
    successor_id: c.successor_id ?? null,
    launch_date: c.launch_date ?? null,
  };
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

/**
 * 平替专区:每个脱销规格 spec_id_a → Top N 平替候选(spec_id_b[])构成一组。
 *
 * 入参:
 *  - extendedMap: 全量 categoryCatalog,用于查找 primary(脱销规格本身可能不在客户在售范围内,
 *    但其图片/名称仍需展示让消费者知道"这位被替代")
 *  - customerOnSaleIds: 客户在售规格 id 集合,alternatives 必须在此集合内
 *  - rules: Map<spec_id_a, spec_id_b[]>(已按 rank 升序),来自 substitute.fetchSubstituteRules
 *
 * 出参:ZoneGroup[]。要求 primary 在 extendedMap 中可查到、alternatives 至少 1 个在售。
 * primary 是否在客户在售并不重要 —— 平替专区的本意就是展示"曾经在售/即将脱销的 A → 现在还在卖的 B/C/D"。
 */
export function classifySubstitute(
  extendedMap: ReadonlyMap<string, Category>,
  customerOnSaleIds: ReadonlySet<string>,
  rules: ReadonlyMap<string, ReadonlyArray<string>>,
): ZoneGroup[] {
  const result: ZoneGroup[] = [];
  for (const [primaryId, altIds] of rules) {
    const primary = extendedMap.get(primaryId);
    if (!primary) continue;
    const alternatives: ZoneSpec[] = [];
    for (const aid of altIds) {
      if (!customerOnSaleIds.has(aid)) continue;
      const alt = extendedMap.get(aid);
      if (!alt) continue;
      alternatives.push(toZoneSpec(alt));
    }
    if (alternatives.length === 0) continue;  // 无在售替代 → 整组淘汰
    result.push({
      primary: toZoneSpec(primary),
      alternatives,
    });
  }
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

/**
 * 怀旧专区:is_delisted = true 的退市规格作为 primary,其 successor_id 在客户在售则组队。
 *
 * 入参:
 *  - specs: 客户在售规格(extendedMap 视图)。primary 必须在 specs 内(即"已退市但门店仍有库存")。
 *  - extendedMap: 全量 catalog,用于查 successor 的展示信息(name / imageUrl)
 *  - customerOnSaleIds: successor 必须在此集合内才能组队
 *
 * successor 缺失 / 未在售 → 整组淘汰(按用户决策:"successor 必须在售才组队")。
 */
export function classifyNostalgia(
  specs: ReadonlyArray<Category>,
  extendedMap: ReadonlyMap<string, Category>,
  customerOnSaleIds: ReadonlySet<string>,
): ZoneGroup[] {
  const result: ZoneGroup[] = [];
  for (const spec of specs) {
    if (spec.is_delisted !== true) continue;
    const successorId = spec.successor_id ?? null;
    if (!successorId) continue;
    if (!customerOnSaleIds.has(successorId)) continue;
    const successor = extendedMap.get(successorId);
    if (!successor) continue;
    result.push({
      primary: toZoneSpec(spec),
      alternatives: [toZoneSpec(successor)],
    });
  }
  // 按 primary name 字典序稳定排序
  result.sort((a, b) => a.primary.name.localeCompare(b.primary.name, 'zh'));
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
 * 一次性运行 5 个分类器并按 primary id 优先级 dedupe。
 *
 * 优先级:industrialCoop > substitute > slowMoving > nostalgia > newProduct。
 * 同一规格在多个专区命中(作为 primary)时,仅保留在第一个命中的专区中。
 *
 * 缺省参数:
 *  - inventoryById 空 → slowMoving 自然返回 []
 *  - substituteRules 空 → substitute 返回 []
 *  - customerOnSaleIds 空 → substitute / nostalgia 因 alternatives 在售校验失败而返回 []
 *  - extendedMap 空 → substitute / nostalgia 无法查 primary/alternatives 而返回 []
 */
export function classifyZones(
  specs: ReadonlyArray<Category>,
  extendedMap: ReadonlyMap<string, Category> = new Map(),
  customerOnSaleIds: ReadonlySet<string> = new Set(),
  inventoryById: ReadonlyMap<string, SpecInventoryInfo> = new Map(),
  substituteRules: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
  now: Date = new Date(),
): ZoneClassification {
  const usedPrimary = new Set<string>();
  const industrialCoop = classifyIndustrialCoop(specs);
  industrialCoop.forEach(s => usedPrimary.add(s.id));

  // substitute 的 primary 是脱销规格,可能不在 specs(客户在售)中,但需要参与 dedupe
  const substituteRaw = classifySubstitute(extendedMap, customerOnSaleIds, substituteRules);
  const substitute = substituteRaw.filter(g => !usedPrimary.has(g.primary.id));
  substitute.forEach(g => usedPrimary.add(g.primary.id));

  const slowSrc = specs.filter(s => !usedPrimary.has(s.id));
  const slowMoving = classifySlowMoving(slowSrc, inventoryById);
  slowMoving.forEach(s => usedPrimary.add(s.id));

  const nostalgiaSrc = specs.filter(s => !usedPrimary.has(s.id));
  const nostalgia = classifyNostalgia(nostalgiaSrc, extendedMap, customerOnSaleIds);
  nostalgia.forEach(g => usedPrimary.add(g.primary.id));

  const newProductSrc = specs.filter(s => !usedPrimary.has(s.id));
  const newProduct = classifyNewProduct(newProductSrc, now);

  return { industrialCoop, substitute, slowMoving, nostalgia, newProduct };
}

/**
 * 单品专区:从 sortedSourceSpecs 中按 ids 过滤出 Category 列表,包装为单品 group(alternatives=[])。
 * 分组专区:把 ZoneGroup 的 primary / alternatives 从 extendedMap 解析为 Category。
 */
function resolveGroupsForZone(
  zoneId: ZoneId,
  classification: ZoneClassification,
  extendedMap: ReadonlyMap<string, Category>,
  sortedSourceSpecs: ReadonlyArray<Category>,
): ZonePlacementGroup[] {
  const meta = ZONE_META[zoneId];
  if (meta.displayMode === 'single') {
    const specs = classification[zoneId] as ZoneSpec[];
    const idSet = new Set(specs.map(s => s.id));
    // 沿 sortedSourceSpecs 的顺序输出,保留 manual 模式下的重复
    return sortedSourceSpecs
      .filter(c => idSet.has(c.id))
      .map(c => ({ primary: c, alternatives: [] }));
  }
  // grouped
  const groups = classification[zoneId] as ZoneGroup[];
  const out: ZonePlacementGroup[] = [];
  for (const g of groups) {
    const primary = extendedMap.get(g.primary.id);
    if (!primary) continue;
    const alts: Category[] = [];
    for (const a of g.alternatives) {
      const cat = extendedMap.get(a.id);
      if (cat) alts.push(cat);
    }
    if (alts.length === 0) continue;
    out.push({ primary, alternatives: alts });
  }
  return out;
}

/**
 * 把 ZoneClassification + 用户的 ZoneAssignment[] 落位为 ZonePlacement[]。
 *
 * - 单品专区:groups[*].primary 来自 sortedSourceSpecs(保留入参排序/重复),alternatives=[]
 * - 分组专区:groups[*].primary 与 alternatives 由 extendedMap 解析为 Category
 *
 * 同一规格作为 primary 时仅出现在一个专区(已通过 classifyZones dedupe);分组专区的 alternatives
 * 仍可能在其它常规陈列中出现,这是合理的——同一规格"既是 X 的平替"也"可作常规品在售"。
 *
 * 注意:与之前一致,zone 规格同时保留在 sortedSourceSpecs(常规陈列池)中,不再扣除。
 */
export function buildZonePlacements(
  classification: ZoneClassification,
  assignments: ReadonlyArray<ZoneAssignment>,
  sortedSourceSpecs: ReadonlyArray<Category>,
  extendedMap: ReadonlyMap<string, Category>,
): ZonePlacement[] {
  const placements: ZonePlacement[] = [];
  for (const assignment of assignments) {
    const meta = ZONE_META[assignment.zone_id];
    if (!meta) continue;
    const groups = resolveGroupsForZone(
      assignment.zone_id,
      classification,
      extendedMap,
      sortedSourceSpecs,
    );
    if (groups.length === 0) continue;
    placements.push({
      zoneId: assignment.zone_id,
      label: meta.label,
      counterId: assignment.counter_id,
      rowCount: assignment.row_count,
      groups,
      displayMode: meta.displayMode,
      barColor: meta.barColor,
      priorityRank: meta.priorityRank,
      groupCount: groups.length,
    });
  }
  return placements;
}

/**
 * 在常规陈列已铺完(regularRowsByCounter 已确定)的前提下,把每个柜台剩余空行
 * 用该柜台已启用的专区填满。轮询分配,按 groupCount 优先级:groupCount 越大越先获得额外行。
 *
 * 规则:
 *  - 仅扩展已启用(在 placements 中存在)的专区;无 placement 的柜台不会新增 zone
 *  - 上限以柜台剩余空闲行(levels - regularRows - currentZoneRows)为准,不再设硬性行数上限
 *  - 剩余无法被分配时,柜台底部保留空层
 *
 * 算法对专区数量不做硬编码,适配后续新增专区。
 */
export function autoExpandZonePlacements(
  placements: ReadonlyArray<ZonePlacement>,
  cabinets: ReadonlyArray<{ id: string; levels: number }>,
  regularRowsByCounter: ReadonlyMap<string, number>,
): ZonePlacement[] {
  // 浅拷贝每个 placement,避免修改入参
  const cloned: ZonePlacement[] = placements.map(p => ({ ...p }));

  const byCounter = new Map<string, ZonePlacement[]>();
  for (const p of cloned) {
    const arr = byCounter.get(p.counterId) || [];
    arr.push(p);
    byCounter.set(p.counterId, arr);
  }

  for (const cabinet of cabinets) {
    const zones = byCounter.get(cabinet.id);
    if (!zones || zones.length === 0) continue;

    const regularRows = regularRowsByCounter.get(cabinet.id) || 0;
    const currentZoneRows = zones.reduce((s, z) => s + z.rowCount, 0);
    let leftover = Math.max(0, cabinet.levels - regularRows - currentZoneRows);
    if (leftover <= 0) continue;

    // groupCount 高 → 优先获得额外行;轮询直至 leftover 用完
    const sorted = [...zones].sort((a, b) => b.groupCount - a.groupCount);
    while (leftover > 0) {
      let progressed = false;
      for (const z of sorted) {
        if (leftover === 0) break;
        z.rowCount = z.rowCount + 1;
        leftover--;
        progressed = true;
      }
      if (!progressed) break;
    }
  }

  return cloned;
}
