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
import {
  beadSubzoneMeta,
  beadSubzoneRank,
  flavorToSubzoneId,
  compareBeadWithinSubzone,
} from './beadSubzones';

/**
 * 专区分类器集合。
 * 纯函数：入参为只读数据结构，出参为新数组，无副作用，可独立单测。
 *
 * 展示模式分两类:
 *  - single    : 单品陈列(每包紧贴),工商共育 / 尝鲜专区 / 爆珠口味组合
 *  - grouped   : 分组陈列(primary + 每个 alternative 均单包,组与组之间留 gap),平替专区 / 产品升级 / 重点推荐区
 *
 * - classifyIndustrialCoop: 工商共育,is_industrial_coop = true                               → ZoneSpec[]
 * - classifySubstitute:    平替专区, 脱销→Top N 平替组合(alternatives 必须在客户在售)       → ZoneGroup[]
 * (产品升级已改为 inlineRegular 红框对,见 inlinePairs.computeInlinePairs,不在本分类器内)
 * - classifySlowMoving:    (重点推荐区子逻辑)滞销,stock_days ≥ 30 且 stock_qty ≥ 3          → ZoneSpec[]
 * - classifyNostalgia:     (重点推荐区子逻辑)怀旧, is_delisted = true 单规格(星标,无需继任)        → ZoneGroup[]
 * - classifyKeyRecommend:  重点推荐区 = 退市星标单品(前) + 滞销单品(后),去重混排                  → ZoneGroup[]
 * - classifyNewProduct:    尝鲜专区, launch_date 在窗口期(一/二类 24 月,其他 12 月)          → ZoneSpec[]
 * - classifyBeadFlavor:    爆珠口味组合,pack_type 含'爆珠',按口味分 3 子专区聚集               → ZoneSpec[]
 * - classifyZones:         一次性返回各专区结果,各专区独立计算,同一品规可在不同专区重复出现
 *
 * 分组专区的 alternatives 不参与去重(允许跨专区出现)。
 */

const SLOW_MOVING_DAYS = 30;
const SLOW_MOVING_QTY = 3;
const HIGH_TIER_NEW_MONTHS = 24;
const DEFAULT_NEW_MONTHS = 12;

const HIGH_TIER_VALUES = new Set(['一类', '二类']);

/** 尝鲜专区「店长推荐」重点品规的**默认**一套(中华 + 牡丹;按 3×2 网格 row-major 顺序:
 *  上行 = 中华细支3mg / 5mg / 6mg(310140/310143/310141),下行 = 金双中 / 玄华双中 / 蓝彩细支(310142/310317/310316))。
 *  这 6 个里**客户在售**的会被注入 newProduct 成员并由 imageGen 在中心 3×2 居中、垫店长推荐装饰。
 *  注意 310143 在 dim_category_ext 无 launch_date,classifyNewProduct 选不到它 —— 靠 injectManagerPicks 绕过窗口注入。
 *
 *  查得到客户消费结构档位时改用 MANAGER_PICK_BY_LEVEL;本常量是查不到档位时的兜底。 */
export const MANAGER_PICK_IDS: string[] = ['310140', '310143', '310141', '310142', '310317', '310316'];

/** 按客户消费客群结构(cust_consumer_structure.structure_level)切换的店长推荐 6 品规。
 *  顺序即 3×2 网格 row-major(上行 3 个、下行 3 个)。方案见
 *  docs/尝鲜专区核心区域-按消费结构分档方案.md(2026-07-20 定稿)。
 *
 *  选品口径:
 *   - **一律是新品**。本专区叫"尝鲜",放老品就是自砸招牌——曾误把中南海(典5,2018 上市)、
 *     中南海(硬酷爽风尚,2012 上市)当低价带补位塞进 low 档,已纠正:补位只能在窗口期新品里找。
 *   - **集团烟新品先行**——先取上海集团 24 个月内上市的新品;集团在该价带不够时,
 *     用**同价带的省外/外烟新品**补(low 档如此),绝不退回集团老品;
 *   - **310143 中华(细支5mg) 恒占 high / mid_high 首位**(用户定),不看价、不看上市窗口;
 *     它无货时该位自然由后一款顺延——injectManagerPicks 只注入客户在售的规格;
 *   - **不回避紧俏烟**(用户定):high / mid_high 档的中华、熊猫新品本身即紧俏品。
 *  改规格改这里即可,injectManagerPicks 与 generate.ts 的高亮子集都读同一份。 */
export const MANAGER_PICK_BY_LEVEL: Record<string, string[]> = {
  // 商务招待 / 团购送礼：礼品带
  high:     ['310143', '310409', '310410', '310140', '310142', '310141'],
  // 教育 / 医疗 / 园区上班 / 商圈 / 游客：中高价带自吸兼小礼
  mid_high: ['310143', '310142', '310141', '310317', '310316', '110131'],
  // 居民 / 工人 / 骑手 / 散客：口粮带（¥160–300）。集团新品在该价带只有前 4 款，
  // 后 2 位用同价带的省外新品补，价带顺势向下贴口粮盘。
  low:      ['310316', '310315', '110131', '310314', '210409', '460203'],
};

/** 免"新品窗口"审计的店长推荐规格：310143 中华(细支5mg) 在 dim_category_ext 无 launch_date,
 *  由用户明确指定恒占 high/mid_high 首位(不看价、不看窗口),故不参与下方超龄告警。 */
const MANAGER_PICK_WINDOW_EXEMPT: ReadonlySet<string> = new Set(['310143']);

/** 已跑过一次超龄审计(每进程一次,避免每次生成都刷日志)。 */
let managerPicksAudited = false;

/**
 * 审计店长推荐名单是否还算"新品"。
 *
 * 存在的理由:MANAGER_PICK_* 是**写死的**,而 injectManagerPicks 又**故意绕过上市窗口**——
 * 两者叠加意味着名单里的规格一旦上市超过 24 个月,会继续躺在"尝鲜专区"核心位上,悄无声息。
 * 这类超龄不会报错、不会崩,只会让专区名不副实,所以必须主动喊出来。
 * 只 console.warn 不改行为:改名单是业务决策,不该由代码替用户做。
 */
function auditManagerPicksAge(extendedMap: ReadonlyMap<string, Category>, now: Date): void {
  if (managerPicksAudited || extendedMap.size === 0) return;
  managerPicksAudited = true;
  const all = new Set<string>([...MANAGER_PICK_IDS, ...Object.values(MANAGER_PICK_BY_LEVEL).flat()]);
  const aged: string[] = [];
  for (const id of all) {
    if (MANAGER_PICK_WINDOW_EXEMPT.has(id)) continue;
    const c = extendedMap.get(id);
    if (!c || !c.launch_date) { aged.push(`${id}(无上市日期)`); continue; }
    const launch = new Date(c.launch_date);
    if (isNaN(launch.getTime())) { aged.push(`${id}(上市日期不可解析)`); continue; }
    const months = monthsBetween(launch, now);
    const window = HIGH_TIER_VALUES.has(c.tier ?? '') ? HIGH_TIER_NEW_MONTHS : DEFAULT_NEW_MONTHS;
    if (months > window) aged.push(`${id} ${c.name}(上市 ${c.launch_date}, 已 ${months} 个月 > ${window})`);
  }
  if (aged.length > 0) {
    console.warn(
      `[zones] 店长推荐名单里有 ${aged.length} 个规格已不在新品窗口内,` +
      `尝鲜专区核心位正在展示老品,请复核 MANAGER_PICK_BY_LEVEL:\n  ${aged.join('\n  ')}`,
    );
  }
}

/** 取该档位的店长推荐规格;档位为空或不在配置内 → 现网默认 MANAGER_PICK_IDS(不猜档)。 */
export function resolveManagerPicks(structureLevel?: string | null): string[] {
  if (!structureLevel) return MANAGER_PICK_IDS;
  return MANAGER_PICK_BY_LEVEL[structureLevel] ?? MANAGER_PICK_IDS;
}


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

// 注:旧「产品升级」分类器 classifyProductUpgrade（上海集团新品 + 同产地/同品牌紧俏 Top2, grouped）
// 已废弃删除。现「产品升级」为 inlineRegular 内嵌红框对,由 services/strategies/inlinePairs.ts
// computeInlinePairs 计算(老品→升级款),不再进 ZoneClassification。

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
 * 怀旧(重点推荐区子逻辑):退市规格 `is_delisted = true` 作为**单规格**陈列(不需要继任、不成组),
 * imageGen 用**星标**(类价签形式)特殊标明,在重点推荐区**排在最前**。
 *
 * 入参:
 *  - specs: 客户规格(extendedMap 视图)。退市品在 specs 内(门店进过该退市品)即可,不再校验继任在售。
 *
 * 返回单品组(alternatives=[]),按 primary name 字典序稳定。
 */
export function classifyNostalgia(
  specs: ReadonlyArray<Category>,
): ZoneGroup[] {
  const result: ZoneGroup[] = [];
  for (const spec of specs) {
    if (spec.is_delisted !== true) continue;
    result.push({
      primary: toZoneSpec(spec),
      alternatives: [],
    });
  }
  // 按 primary name 字典序稳定排序
  result.sort((a, b) => a.primary.name.localeCompare(b.primary.name, 'zh'));
  return result;
}

/**
 * 重点推荐区(原"滞销夸夸角" + "怀旧专区"合并):grouped 模式,全为单品组(alternatives=[])。
 *
 *  - 怀旧(退市)组:classifyNostalgia 的结果,{primary: 退市规格, alternatives: []};imageGen 加**星标**,排最前
 *  - 滞销组:classifySlowMoving 的结果包装为 {primary: 滞销规格, alternatives: []}
 *
 * 退市组在前、滞销组在后。同一 primary 不重复 —— 既退市又滞销时优先以退市(星标)形态保留,滞销侧跳过。
 *
 * imageGen 的 grouped 绘制 + drawGroupedZoneRow 天然支持 alternatives=[] 的单品组(只画 primary,
 * is_delisted 时叠星标),因此无需新增 displayMode。
 */
export function classifyKeyRecommend(
  specs: ReadonlyArray<Category>,
  inventoryById: ReadonlyMap<string, SpecInventoryInfo>,
): ZoneGroup[] {
  const nostalgiaGroups = classifyNostalgia(specs);
  const slowMovingSpecs = classifySlowMoving(specs, inventoryById);

  const seen = new Set<string>(nostalgiaGroups.map(g => g.primary.id));
  const slowGroups: ZoneGroup[] = [];
  for (const s of slowMovingSpecs) {
    if (seen.has(s.id)) continue;  // 已作为退市 primary 出现,不重复
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
 * 把「店长推荐」重点品规(按客户消费结构档位取 resolveManagerPicks)中**客户在售**且尚未入选的
 * 注入 newProduct,绕过上市窗口。
 * 例:310143 无 launch_date,classifyNewProduct 不会选它,但只要客户在售就应进尝鲜专区中心被高亮。
 * imageGen 凭 placement.highlightIds(generate.ts 计算)决定谁加框/加宽,这里只负责"让它进专区"。
 * 原地 push 后返回同一数组(调用方 classifyZones 持有该新数组)。
 */
function injectManagerPicks(
  newProduct: ZoneSpec[],
  extendedMap: ReadonlyMap<string, Category>,
  customerOnSaleIds: ReadonlySet<string>,
  structureLevel?: string | null,
  now: Date = new Date(),
): ZoneSpec[] {
  auditManagerPicksAge(extendedMap, now);
  const present = new Set(newProduct.map(s => s.id));
  for (const id of resolveManagerPicks(structureLevel)) {
    if (present.has(id) || !customerOnSaleIds.has(id)) continue; // 仅在售、未重复
    const c = extendedMap.get(id);
    if (c) newProduct.push(toZoneSpec(c));
  }
  return newProduct;
}

/**
 * 爆珠口味组合:仅爆珠规格,按口味分 3 个子专区(果香花香 / 酒香饮品 / 特色草本 + 未匹配的"其他")聚集陈列。
 * 分类与段内排序规则全部集中在 beadSubzones.ts(用户唯一维护处)。
 *
 *  范围:pack_type 含 '爆珠' 的所有变体(爆珠 / 中支爆珠 / 细支爆珠 / 短支爆珠)。
 *  允许与其它专区重叠 —— 各专区独立计算,同一爆珠规格可同时出现在多个专区。
 *
 *  输出:扁平 ZoneSpec[],**已是最终陈列序**:
 *   - 外层 = BEAD_SUBZONES 配置顺序,"其他"段恒最后(beadSubzoneRank);
 *   - 段内 = compareBeadWithinSubzone(铺市面↑ → 订足率↓ → 兜底价↓);
 *   - 每项带 subzoneId,供 buildZonePlacements 切段 + imageGen 左栏分段竖标。
 *
 *  缺失数据上报:收集缺 market_coverage / order_fill_rate 的爆珠,console.warn 一条汇总
 *  (pm2 logs 可见),方便补齐;数据补全前这些规格在段内退化为按价格排。
 */
export function classifyBeadFlavor(specs: ReadonlyArray<Category>): ZoneSpec[] {
  const beads = specs.filter(s => (s.pack_type ?? '').includes('爆珠'));
  if (beads.length === 0) return [];

  // 按子专区分桶
  const buckets = new Map<string, Category[]>();
  for (const s of beads) {
    const szId = flavorToSubzoneId(s.flavor);
    const list = buckets.get(szId);
    if (list) list.push(s);
    else buckets.set(szId, [s]);
  }

  // 段内排序 + 按子专区 rank(配置顺序,其他段最后)拼扁平
  const orderedIds = [...buckets.keys()].sort((a, b) => beadSubzoneRank(a) - beadSubzoneRank(b));
  const result: ZoneSpec[] = [];
  for (const szId of orderedIds) {
    const list = buckets.get(szId)!;
    list.sort(compareBeadWithinSubzone);
    for (const s of list) {
      result.push({ id: s.id, name: s.name, imageUrl: s.imageUrl, subzoneId: szId });
    }
  }

  // 缺失指标上报(开发自查;不影响出图)
  const missing = beads.filter(s => s.market_coverage == null || s.order_fill_rate == null);
  if (missing.length > 0) {
    const sample = missing.slice(0, 20).map(s => `${s.id}${s.name ? '(' + s.name + ')' : ''}`).join('、');
    console.warn(
      `[beadFlavor] ${missing.length}/${beads.length} 个爆珠缺 铺市面(market_coverage)/订足率(order_fill_rate),` +
      `这些规格段内暂按价格降序排。补全后自动按业务排序。示例:${sample}${missing.length > 20 ? ' …' : ''}`
    );
  }

  return result;
}

/**
 * 一次性运行各分类器,各专区独立计算,同一品规可在不同专区重复出现。
 *
 * 缺省参数:
 *  - inventoryById 空 → keyRecommend 的滞销部分自然返回 []
 *  - substituteRules 空 → substitute 返回 []
 *  - customerOnSaleIds 空 → substitute / keyRecommend(怀旧) 因 alternatives 在售校验失败而返回 []
 *  - extendedMap 空 → substitute / keyRecommend 无法查 primary/alternatives 而返回 []
 */
export function classifyZones(
  specs: ReadonlyArray<Category>,
  extendedMap: ReadonlyMap<string, Category> = new Map(),
  customerOnSaleIds: ReadonlySet<string> = new Set(),
  inventoryById: ReadonlyMap<string, SpecInventoryInfo> = new Map(),
  substituteRules: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
  now: Date = new Date(),
  /** 客户消费结构档位(high/mid_high/low)：只影响尝鲜专区店长推荐那 6 个规格；
   *  传 null/undefined 即回退现网默认，故所有旧调用点行为不变。 */
  structureLevel?: string | null,
): ZoneClassification {
  const industrialCoop = classifyIndustrialCoop(specs);
  const substitute = classifySubstitute(extendedMap, customerOnSaleIds, substituteRules, inventoryById);
  const keyRecommend = classifyKeyRecommend(specs, inventoryById);
  // 尝鲜专区:窗口期新品 + 注入在售的店长推荐重点品规(后者绕过上市窗口,如 310143)
  const newProduct = injectManagerPicks(classifyNewProduct(specs, now), extendedMap, customerOnSaleIds, structureLevel, now);
  const beadFlavor = classifyBeadFlavor(specs);

  return { industrialCoop, substitute, keyRecommend, newProduct, beadFlavor };
}

/**
 * 单品专区:从 sortedSourceSpecs 中按 ids 过滤出 Category 列表,包装为单品 group(alternatives=[])。
 * 分组专区:把 ZoneGroup 的 primary / alternatives 从 extendedMap 解析为 Category。
 *   - substitute:alternatives 解析后为空的组整组淘汰(替代品全部查不到=无意义)
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
  // priceTag(纯开关)与 productUpgrade(inlineRegular 红框对,由 computeInlinePairs 接管)均不进 ZoneClassification、
  // 也不会走到这里落位,一并排除以对齐分类表的键集。
  const clsKey = zoneId as Exclude<ZoneId, 'festivalSeason' | 'priceTag' | 'productUpgrade'>;
  // 爆珠:保留 classifyBeadFlavor 的「子专区序 + 段内业务排序」,不经 sortedSourceSpecs 重排
  // (下方 generic single 分支会用常规排序覆盖顺序,故爆珠在此单独处理)。
  if (zoneId === 'beadFlavor') {
    const out: ZonePlacementGroup[] = [];
    for (const s of classification.beadFlavor) {
      const primary = extendedMap.get(s.id);
      if (primary) out.push({ primary, alternatives: [] });
    }
    return out;
  }
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
    // 爆珠:按 primary 的 flavor 重算子专区,切连续同段为 subZones(groups 已是子专区有序序列)
    if (assignment.zone_id === 'beadFlavor') {
      placement.subZones = buildBeadSubZones(groups);
    }
    placements.push(placement);
  }
  return placements;
}

/** 把爆珠的(子专区有序)groups 切成 subZones 元信息:连续相同子专区为一段,取配置的 label/icon/color + count。 */
function buildBeadSubZones(
  groups: ReadonlyArray<ZonePlacementGroup>,
): NonNullable<ZonePlacement['subZones']> {
  const out: NonNullable<ZonePlacement['subZones']> = [];
  for (const g of groups) {
    const szId = flavorToSubzoneId(g.primary.flavor);
    const last = out[out.length - 1];
    if (last && last.id === szId) {
      last.count += 1;
    } else {
      const m = beadSubzoneMeta(szId);
      out.push({ id: m.id, label: m.label, iconImage: m.iconImage, barColor: m.barColor, count: 1 });
    }
  }
  return out;
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
