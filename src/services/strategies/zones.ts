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
 * 专区分类器集合。
 * 纯函数：入参为只读数据结构，出参为新数组，无副作用，可独立单测。
 *
 * 展示模式分两类:
 *  - single    : 单品陈列(每包紧贴),工商共育 / 尝鲜专区 / 爆珠口味组合
 *  - grouped   : 分组陈列(primary + 每个 alternative 均单包,组与组之间留 gap),平替专区 / 产品升级 / 重点推荐区
 *
 * - classifyIndustrialCoop: 工商共育,is_industrial_coop = true                               → ZoneSpec[]
 * - classifyProductUpgrade: 产品升级,上海集团新品+同产地/同品牌的集团紧俏 Top 2              → ZoneGroup[]
 * - classifySubstitute:    平替专区, 脱销→Top N 平替组合(alternatives 必须在客户在售)       → ZoneGroup[]
 * - classifySlowMoving:    (重点推荐区子逻辑)滞销,stock_days ≥ 30 且 stock_qty ≥ 3          → ZoneSpec[]
 * - classifyNostalgia:     (重点推荐区子逻辑)怀旧, is_delisted = true && successor 在售      → ZoneGroup[]
 * - classifyKeyRecommend:  重点推荐区 = 怀旧组 + 滞销组(去重)混排                             → ZoneGroup[]
 * - classifyNewProduct:    尝鲜专区, launch_date 在窗口期(一/二类 24 月,其他 12 月)          → ZoneSpec[]
 * - classifyBeadFlavor:    爆珠口味组合,pack_type 含'爆珠',按口味聚集                        → ZoneSpec[]
 * - classifyZones:         一次性返回各专区结果,各专区独立计算,同一品规可在不同专区重复出现
 *
 * 分组专区的 alternatives 不参与去重(允许跨专区出现)。
 */

const SLOW_MOVING_DAYS = 30;
const SLOW_MOVING_QTY = 3;
const HIGH_TIER_NEW_MONTHS = 24;
const DEFAULT_NEW_MONTHS = 12;
const SHANGHAI_TOBACCO_MFR = '上海烟草集团有限责任公司';

const HIGH_TIER_VALUES = new Set(['一类', '二类']);

/** 爆珠口味组合的 flavor 外层顺序(薄荷>水果>功能性>原味>其他)。 */
const BEAD_FLAVOR_ORDER = ['薄荷', '水果', '功能性', '原味'];

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
 * 产品升级:上海集团新品作为 primary,搭配同产地/同品牌的集团紧俏组合,grouped 模式。
 *
 * 入参:
 *  - specs: 客户在售规格(extendedMap 视图)。primary 必须在 specs 内 —— 门店没卖的新品凭空陈列没意义。
 *  - extendedMap: 全量 catalog,用于从全量中筛 alt 候选池(不限于客户在售外的规格)
 *  - customerOnSaleIds: alt 必须在此集合内才能组队(避免陈列出客户没货的紧俏烟,顾客想买却买不到)
 *
 * primary 判定(必须全部满足):
 *  - manufacturer === '上海烟草集团有限责任公司'
 *  - launch_date 在窗口期内(沿用 newProduct 判定:tier ∈ {一类, 二类} → 24 个月,其他 12 个月)
 *
 * alternatives 候选池 = manufacturer === '上海烟草集团有限责任公司' && is_hot === true && 在客户在售。
 * 候选池在循环外算一次,与 primary 无关,所有 primary 共用同一池。
 *
 * alt 排序(同产地 > 同品牌 > 价格接近):
 *  1. province 与 primary 相同者优(集团内省外烟主要为云南,部分品牌产地差异较大)
 *  2. brand    与 primary 相同者优(同品牌"系列升级"语义最强)
 *  3. |alt.price - primary.price| 越小越优
 * tie 时保留 extendedMap 入参顺序(JS sort 已稳定),即 categories.json 的录入顺序。
 *
 * 取 Top 2。残缺组(只找到 1 个紧俏组合)排到末尾,避免与 3 包完整组混排破坏视觉。
 * 候选池为 0 或排序后过滤 self 后为 0 → 整组淘汰。
 */
export function classifyProductUpgrade(
  specs: ReadonlyArray<Category>,
  extendedMap: ReadonlyMap<string, Category>,
  customerOnSaleIds: ReadonlySet<string>,
  now: Date = new Date(),
): ZoneGroup[] {
  // alt 候选池:上海集团 + is_hot + 在客户在售 + 非新品(防横跳)
  const altCandidates: Category[] = [];
  for (const c of extendedMap.values()) {
    if (c.manufacturer !== SHANGHAI_TOBACCO_MFR) continue;
    if (c.is_hot !== true) continue;
    if (!customerOnSaleIds.has(c.id)) continue;
    // 排除新品窗口内的规格,避免"A→B 同时 B→A"的来回横跳
    if (c.launch_date) {
      const altLaunch = new Date(c.launch_date);
      if (!isNaN(altLaunch.getTime())) {
        const altMonths = monthsBetween(altLaunch, now);
        if (altMonths >= 0) {
          const altWin = HIGH_TIER_VALUES.has(c.tier ?? '') ? HIGH_TIER_NEW_MONTHS : DEFAULT_NEW_MONTHS;
          if (altMonths <= altWin) continue;
        }
      }
    }
    altCandidates.push(c);
  }

  const fullGroups: ZoneGroup[] = [];
  const partialGroups: ZoneGroup[] = [];

  for (const primary of specs) {
    if (primary.manufacturer !== SHANGHAI_TOBACCO_MFR) continue;
    if (!primary.launch_date) continue;
    const launch = new Date(primary.launch_date);
    if (isNaN(launch.getTime())) continue;
    const months = monthsBetween(launch, now);
    if (months < 0) continue;
    const window = HIGH_TIER_VALUES.has(primary.tier ?? '') ? HIGH_TIER_NEW_MONTHS : DEFAULT_NEW_MONTHS;
    if (months > window) continue;

    // 业务多准则排序(同产地 > 同品牌 > 价格接近),tie 时保留 extendedMap 顺序
    const sorted = altCandidates
      .filter(c => c.id !== primary.id)
      .slice()
      .sort((a, b) => {
        const aProv = a.province === primary.province ? 0 : 1;
        const bProv = b.province === primary.province ? 0 : 1;
        if (aProv !== bProv) return aProv - bProv;

        const aBrand = a.brand === primary.brand ? 0 : 1;
        const bBrand = b.brand === primary.brand ? 0 : 1;
        if (aBrand !== bBrand) return aBrand - bBrand;

        const aPriceDiff = Math.abs((a.price ?? 0) - (primary.price ?? 0));
        const bPriceDiff = Math.abs((b.price ?? 0) - (primary.price ?? 0));
        return aPriceDiff - bPriceDiff;
      });

    if (sorted.length === 0) continue;
    const top = sorted.slice(0, 2);
    const group: ZoneGroup = {
      primary: toZoneSpec(primary),
      alternatives: top.map(toZoneSpec),
    };

    if (top.length >= 2) fullGroups.push(group);
    else partialGroups.push(group);
  }
  return [...fullGroups, ...partialGroups];
}

/**
 * 平替专区:每个脱销规格 spec_id_a → 候选池 → 业务排序后选 Top 2 → 组成 ZoneGroup。
 *
 * 入参:
 *  - extendedMap: 全量 categoryCatalog,用于查找 primary 与候选的 Category(含 price/province/pack_type)
 *  - customerOnSaleIds: 客户在售规格 id 集合(stock_qty > 0),候选必须在此集合内
 *  - rules: Map<spec_id_a, candidateIds[]>(已按 rank 升序),来自 substitute.fetchSubstituteRules
 *  - inventoryById: 候选的库存信息,业务排序最末位用 stock_qty 排序
 *
 * 业务排序优先级(价格 > 产地 > 支型 > 库存):
 *  1. 价格:|alt.price - primary.price| 越小越优
 *  2. 产地:province 与 primary 相同者优
 *  3. 支型:pack_type 与 primary 相同者优
 *  4. 库存:stock_qty 越大越优(在售前提下"库存厚"的更适合主推)
 * tie 时保留 rules 入参顺序(JS sort 已稳定),即原 ref_co_purchase_rules 的 rank。
 *
 * 残缺组(只找到 1 个替代,候选池过滤后不足 2)排到结果末尾,避免与 5 格完整组混排破坏视觉。
 * 候选池过滤后为 0 → 整组淘汰。
 *
 * primary 是否在客户在售并不重要 —— 平替专区本意就是展示"曾经在售/即将脱销的 A → 现在还在卖的 B/C"。
 */
export function classifySubstitute(
  extendedMap: ReadonlyMap<string, Category>,
  customerOnSaleIds: ReadonlySet<string>,
  rules: ReadonlyMap<string, ReadonlyArray<string>>,
  inventoryById: ReadonlyMap<string, SpecInventoryInfo> = new Map(),
): ZoneGroup[] {
  const fullGroups: ZoneGroup[] = [];
  const partialGroups: ZoneGroup[] = [];
  for (const [primaryId, candidateIds] of rules) {
    const primary = extendedMap.get(primaryId);
    if (!primary) continue;

    // 1. 过滤候选:在客户在售集合内 + 在 extendedMap 中有 Category
    const candidates: Category[] = [];
    for (const aid of candidateIds) {
      if (!customerOnSaleIds.has(aid)) continue;
      const cat = extendedMap.get(aid);
      if (cat) candidates.push(cat);
    }
    if (candidates.length === 0) continue;  // 无在售替代 → 整组淘汰

    // 2. 业务多准则排序
    candidates.sort((a, b) => {
      const aPriceDiff = Math.abs((a.price ?? 0) - (primary.price ?? 0));
      const bPriceDiff = Math.abs((b.price ?? 0) - (primary.price ?? 0));
      if (aPriceDiff !== bPriceDiff) return aPriceDiff - bPriceDiff;

      const aProv = a.province === primary.province ? 0 : 1;
      const bProv = b.province === primary.province ? 0 : 1;
      if (aProv !== bProv) return aProv - bProv;

      const aPack = (a.pack_type ?? '') === (primary.pack_type ?? '') ? 0 : 1;
      const bPack = (b.pack_type ?? '') === (primary.pack_type ?? '') ? 0 : 1;
      if (aPack !== bPack) return aPack - bPack;

      const aStock = inventoryById.get(a.id)?.stock_qty ?? 0;
      const bStock = inventoryById.get(b.id)?.stock_qty ?? 0;
      return bStock - aStock;
    });

    // 3. 业务排序后取 Top 2
    const top = candidates.slice(0, 2);
    const group: ZoneGroup = {
      primary: toZoneSpec(primary),
      alternatives: top.map(toZoneSpec),
    };

    // 4. 完整组(2 个替代)与残缺组(1 个替代)分桶,残缺组放到末尾
    if (top.length >= 2) fullGroups.push(group);
    else partialGroups.push(group);
  }
  return [...fullGroups, ...partialGroups];
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

/**
 * 重点推荐区(原"滞销夸夸角" + "怀旧专区"合并):grouped 模式,两类组混排。
 *
 *  - 怀旧组:classifyNostalgia 的结果,{primary: 退市规格, alternatives: [在售继任]}(2 包宽)
 *  - 滞销组:classifySlowMoving 的结果包装为 {primary: 滞销规格, alternatives: []}(1 包宽,单品)
 *
 * 怀旧组在前、滞销组在后。同一 primary 不重复出现 —— 若某规格既退市又滞销,优先以怀旧组形态保留,
 * 滞销侧跳过(避免本专区内同一规格出现两次)。
 *
 * imageGen 的 grouped 绘制 + drawGroupedZoneRow 天然支持 alternatives=[] 的单品组(只画 primary),
 * 因此无需新增 displayMode。
 */
export function classifyKeyRecommend(
  specs: ReadonlyArray<Category>,
  extendedMap: ReadonlyMap<string, Category>,
  customerOnSaleIds: ReadonlySet<string>,
  inventoryById: ReadonlyMap<string, SpecInventoryInfo>,
): ZoneGroup[] {
  const nostalgiaGroups = classifyNostalgia(specs, extendedMap, customerOnSaleIds);
  const slowMovingSpecs = classifySlowMoving(specs, inventoryById);

  const seen = new Set<string>(nostalgiaGroups.map(g => g.primary.id));
  const slowGroups: ZoneGroup[] = [];
  for (const s of slowMovingSpecs) {
    if (seen.has(s.id)) continue;  // 已作为怀旧 primary 出现,不重复
    seen.add(s.id);
    slowGroups.push({ primary: s, alternatives: [] });
  }
  return [...nostalgiaGroups, ...slowGroups];
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
 * 爆珠口味组合:仅爆珠规格,按口味分组聚集陈列。
 *
 *  范围:pack_type 含 '爆珠' 的所有变体(爆珠 / 中支爆珠 / 细支爆珠 / 短支爆珠)。
 *  允许与 shortSlimBead 重叠 —— 各专区独立计算,同一爆珠规格可同时出现在两个专区。
 *
 *  排序(语义:"同口味集中摆放方便横向比较"):
 *   - 外层 flavor 顺序:薄荷 > 水果 > 功能性 > 原味 > 其他(包括 null / 空)
 *   - 组内按 price 降序(高价位放前,先抓住客户)
 *  tie 时保留入参顺序(JS sort 稳定)。
 *
 *  注意:imageGen 的 single 模式按 spec id 切换处加 gap,所以"同 flavor 组内"和
 *  "不同 flavor 之间"的视觉间隙是一致的(都因 id 切换出现 gap)。若后续需要"同 flavor
 *  紧贴 + 组间大 gap"的强分组视觉,需扩展 displayMode 为 clustered,本轮不做。
 */
export function classifyBeadFlavor(specs: ReadonlyArray<Category>): ZoneSpec[] {
  const buckets = new Map<string, Category[]>();
  for (const spec of specs) {
    if (!(spec.pack_type ?? '').includes('爆珠')) continue;
    const flavor = spec.flavor || '其他';
    const list = buckets.get(flavor);
    if (list) list.push(spec);
    else buckets.set(flavor, [spec]);
  }
  // 组内按 price desc
  for (const list of buckets.values()) {
    list.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
  }
  const result: ZoneSpec[] = [];
  // 外层按 BEAD_FLAVOR_ORDER 顺序拼接
  for (const f of BEAD_FLAVOR_ORDER) {
    const list = buckets.get(f);
    if (!list) continue;
    for (const s of list) {
      result.push({ id: s.id, name: s.name, imageUrl: s.imageUrl });
    }
  }
  // 兜底:未在 BEAD_FLAVOR_ORDER 中的 flavor(含'其他')排到最后,按 flavor 名字典序稳定
  const tailFlavors = [...buckets.keys()]
    .filter(f => !BEAD_FLAVOR_ORDER.includes(f))
    .sort();
  for (const f of tailFlavors) {
    for (const s of buckets.get(f)!) {
      result.push({ id: s.id, name: s.name, imageUrl: s.imageUrl });
    }
  }
  return result;
}

/**
 * 一次性运行各分类器,各专区独立计算,同一品规可在不同专区重复出现。
 *
 * 缺省参数:
 *  - inventoryById 空 → keyRecommend 的滞销部分自然返回 []
 *  - substituteRules 空 → substitute 返回 []
 *  - customerOnSaleIds 空 → substitute / keyRecommend(怀旧) / productUpgrade 因 alternatives 在售校验失败而返回 []
 *  - extendedMap 空 → substitute / keyRecommend / productUpgrade 无法查 primary/alternatives 而返回 []
 */
export function classifyZones(
  specs: ReadonlyArray<Category>,
  extendedMap: ReadonlyMap<string, Category> = new Map(),
  customerOnSaleIds: ReadonlySet<string> = new Set(),
  inventoryById: ReadonlyMap<string, SpecInventoryInfo> = new Map(),
  substituteRules: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
  now: Date = new Date(),
): ZoneClassification {
  const industrialCoop = classifyIndustrialCoop(specs);
  const productUpgrade = classifyProductUpgrade(specs, extendedMap, customerOnSaleIds, now);
  const substitute = classifySubstitute(extendedMap, customerOnSaleIds, substituteRules, inventoryById);
  const keyRecommend = classifyKeyRecommend(specs, extendedMap, customerOnSaleIds, inventoryById);
  const newProduct = classifyNewProduct(specs, now);
  const beadFlavor = classifyBeadFlavor(specs);

  return { industrialCoop, productUpgrade, substitute, keyRecommend, newProduct, beadFlavor };
}

/**
 * 单品专区:从 sortedSourceSpecs 中按 ids 过滤出 Category 列表,包装为单品 group(alternatives=[])。
 * 分组专区:把 ZoneGroup 的 primary / alternatives 从 extendedMap 解析为 Category。
 *   - substitute / productUpgrade:alternatives 解析后为空的组整组淘汰(替代品全部查不到=无意义)
 *   - keyRecommend:允许 alternatives=[] 的组保留(原滞销品本就是单品,不应被淘汰)
 */
function resolveGroupsForZone(
  zoneId: ZoneId,
  classification: ZoneClassification,
  extendedMap: ReadonlyMap<string, Category>,
  sortedSourceSpecs: ReadonlyArray<Category>,
): ZonePlacementGroup[] {
  const meta = ZONE_META[zoneId];
  // festivalSeason 数据流隔离,不进 classification;buildZonePlacements 调用方已过滤,此处仅防御
  if (meta.displayMode === 'backFestival') return [];
  const clsKey = zoneId as Exclude<ZoneId, 'festivalSeason'>;
  if (meta.displayMode === 'single') {
    const specs = classification[clsKey] as ZoneSpec[];
    const idSet = new Set(specs.map(s => s.id));
    // 沿 sortedSourceSpecs 的顺序输出,保留 manual 模式下的重复
    return sortedSourceSpecs
      .filter(c => idSet.has(c.id))
      .map(c => ({ primary: c, alternatives: [] }));
  }
  // grouped
  const groups = classification[clsKey] as ZoneGroup[];
  // keyRecommend 的滞销组天生 alternatives=[],不可淘汰;其余分组专区空 alternatives 视为无效组
  const keepEmptyAlts = zoneId === 'keyRecommend';
  const out: ZonePlacementGroup[] = [];
  for (const g of groups) {
    const primary = extendedMap.get(g.primary.id);
    if (!primary) continue;
    const alts: Category[] = [];
    for (const a of g.alternatives) {
      const cat = extendedMap.get(a.id);
      if (cat) alts.push(cat);
    }
    if (alts.length === 0 && !keepEmptyAlts) continue;
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
 * 同一规格作为 primary 时可出现在多个专区(各专区独立计算);分组专区的 alternatives
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
    // 纯开关专区不产出占行 placement(zone-select 只送 counter_id='' 的占位 assignment):
    //  - fixedTop(工商共育):由 generate.ts buildIndustrialCoopPlacement 单独构造顶部条行
    //  - inlineRegular(产品升级/平替):由 generate.ts computeInlinePairs 嵌入常规行红框
    // 若在此按空 counter_id 生成 placement,会在 generate.ts「柜台合法性校验」处落空 404。
    if (meta.layoutKind === 'inlineRegular' || meta.layoutKind === 'fixedTop') continue;
    const groups = resolveGroupsForZone(
      assignment.zone_id,
      classification,
      extendedMap,
      sortedSourceSpecs,
    );
    if (groups.length === 0) continue;
    const placement: ZonePlacement = {
      zoneId: assignment.zone_id,
      label: meta.label,
      counterId: assignment.counter_id,
      rowCount: assignment.row_count,
      groups,
      displayMode: meta.displayMode,
      layoutKind: meta.layoutKind,
      barColor: meta.barColor,
      priorityRank: meta.priorityRank,
      groupCount: groups.length,
    };
    placements.push(placement);
  }
  return placements;
}

/**
 * 在常规陈列已铺完(regularRowsByCounter 已确定)的前提下,把每个柜台剩余空行
 * 用该柜台已启用的专区填满。轮询分配,按 groupCount 优先级:groupCount 越大越先获得额外行。
 *
 * 规则:
 *  - 仅扩展已启用(在 placements 中存在)的专区;无 placement 的柜台不会新增 zone
 *  - 上限以柜台剩余空闲行(levels - regularRows - currentZoneRows)为准,不设其他硬上限
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
