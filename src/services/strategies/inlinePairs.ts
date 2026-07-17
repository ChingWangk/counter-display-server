import { Category } from '../../types';
import { SpecInventoryInfo } from './types';

/**
 * 内嵌红框配对(产品升级 / 滞销平替,layoutKind='inlineRegular')。
 *
 * 业务:这两个专区不再单独占行,而是从常规陈列中找出「主规格」,在其右侧紧跟一个「副规格」,
 * 由 imageGen 用粗红框圈住这对。本模块负责「主规格 → 副规格」的配对计算(纯函数,可单测),
 * 不涉及绘制/落位。
 *
 * 主规格判定:必须已在常规陈列池 specs 中(字面实现"从常规陈列中找出主规格")。
 *  - 产品升级 primary = 待升级老品;substitute primary = 脱销规格(stock_qty=0)。
 *
 * 副规格选取(每个主规格只配一个最高优先级副规格):
 *  - 写死配对:见 UPGRADE_PAIRS / SUBSTITUTE_PAIRS。升级款强制客户在售(不在售则跳过、留给派生);平替维持无条件。
 *  - 自动派生(写死未命中时):
 *    · 升级(高置信):同品牌 + 同支型(pack_type) + 同价类(tier) + 副规格**零售价**更高且价差 ≤30 元 + 上市更晚;
 *           取上市最新(tie 价差最小)。比价用零售价(dim_category_ext.price,与升级明细「每包多赚」同口径),
 *           主/副任一零售价缺失或主规格无价类则不派生;升级款强制客户在售(只在 onSaleIds 里找,不推客户还没进的货)。
 *           所有客户统一封顶 10 组(写死配对优先保留),避免红框糊满整柜。
 *    · 平替:主规格须脱销(近一周脱销集 recentStockoutFreq,缺省回退 stock_qty=0);副规格按 同品牌 → 同价位段(tier) → 同支型 取最优,且强制客户在售。
 *      所有客户统一封顶 10 组(写死平替优先保留,派生按季度脱销频次降序取前 N)。
 *
 * 优先级:**写死配对(升级/平替)> 自动派生**;同档内升级 > 平替。
 *   —— 写死优先于派生,避免"写死平替主规格恰好也能派生升级"被升级抢走(如 320512)。
 * 同一 primaryId 不重复配;副规格不得又被当作别组主规格(防链式/重复框)。
 */

/** 产品升级写死配对(主规格编码 → 升级副规格编码)。同品牌、副规格价更高。 */
const UPGRADE_PAIRS: Record<string, string> = {
  '310133': '310142', // 中华(双中支)¥424 → 中华(金双中)¥510
  '310310': '310317', // 牡丹(蓝中支)¥263 → 牡丹(玄华双中)¥339
  '340135': '340142', // 黄山(红方印细支)¥175 → 黄山(红方印金细支)¥263
};

/** 滞销平替写死配对(脱销主规格编码 → 平替副规格编码)。跨品牌、同价位段。 */
const SUBSTITUTE_PAIRS: Record<string, string> = {
  '330421': '423801', // 利群(软蓝)¥159 → 黄鹤楼(软蓝)¥164
  '330409': '310102', // 利群(软长嘴)¥318 → 中华(硬)¥382
  '320512': '360122', // 南京(炫赫门)¥155 → 金圣(青瓷)¥158
};

const UPGRADE_LABEL = '产品升级';
const SUBSTITUTE_LABEL = '滞销平替';

/**
 * 「产品升级」配对组数上限(所有客户统一封顶)。
 * 升级红框意在"精选引导",数量过多会糊满整柜、失去重点。故:写死配对(UPGRADE_PAIRS)优先全保留,
 * 其余自动派生升级按常规陈列出现顺序保留到上限为止,超出的还原为普通包(不画框、不额外插入副规格)。
 * 平替(SUBSTITUTE)不计入、不受影响。个别客户可在 UPGRADE_PAIR_CAP_BY_CUSTOMER 覆盖默认值。
 */
const DEFAULT_UPGRADE_PAIR_CAP = 10;
const UPGRADE_PAIR_CAP_BY_CUSTOMER: Record<string, number> = {
  // 如需为个别客户单独调整上限,在此覆盖,例如 '116314785': 6;缺省一律用 DEFAULT_UPGRADE_PAIR_CAP。
};

/** 「滞销平替」配对组数上限(所有客户统一封顶)。写死平替优先保留,其余派生按**季度脱销频次降序**补到上限。 */
const DEFAULT_SUBSTITUTE_PAIR_CAP = 10;

/** 派生升级的每包价差护栏(元):升级款零售价 − 老品零售价 须在 (0, 此值] 内,超出视为跨消费层级、非升级。 */
const MAX_UPGRADE_PRICE_DIFF = 30;

/** 一对内嵌红框配对:主规格(已在常规) + 紧跟其右侧的副规格。 */
export interface InlineBoxedPair {
  /** 主规格 id(出现在常规陈列序列中) */
  primaryId: string;
  /** 副规格 Category(插到主规格右侧,与之同框) */
  secondary: Category;
  zoneId: 'productUpgrade' | 'substitute';
  /** 红框左上角标签文字:'产品升级' | '滞销平替' */
  boxLabel: string;
}

export interface ComputeInlinePairsArgs {
  /** 常规陈列池(主规格须在此;保序) */
  specs: ReadonlyArray<Category>;
  enableUpgrade: boolean;
  enableSubstitute: boolean;
  /** 全量 catalog(含 dim_category_ext 字段),用于解析副规格 + 派生候选 */
  extendedMap: ReadonlyMap<string, Category>;
  /** 客户在售规格集合(stock_qty > 0),平替派生候选必须在此集合内 */
  onSaleIds: ReadonlySet<string>;
  /** spec_id → 库存快照,平替主规格脱销判定的**回退**口径(stock_qty === 0)用 */
  inventoryById: ReadonlyMap<string, SpecInventoryInfo>;
  /**
   * 近一周脱销规格 → 季度脱销频次(cust_recent_stockout,POS 日结窗口 [L-6,L] 内出现过脱销,含已回补;
   * 值 = 最近 13 周脱销天数)。键的存在=可作平替主规格;值供平替封顶按频次降序取前 N。
   * 为 null/undefined 时回退 inventoryById.stock_qty===0(旧月度口径)且封顶按出现序。
   */
  recentStockoutFreq?: ReadonlyMap<string, number> | null;
  /** 客户编号。命中 UPGRADE_PAIR_CAP_BY_CUSTOMER 时,产品升级配对裁到该上限(写死配对必留)。缺省不限。 */
  customerId?: string;
}

/**
 * 计算内嵌红框配对。返回 Map<primaryId, InlineBoxedPair>(key = 主规格 id)。
 * 两个专区都未启用 → 返回空 Map。
 */
export function computeInlinePairs(args: ComputeInlinePairsArgs): Map<string, InlineBoxedPair> {
  const { specs, enableUpgrade, enableSubstitute, extendedMap, onSaleIds, inventoryById, recentStockoutFreq, customerId } = args;
  const pairs = new Map<string, InlineBoxedPair>();
  if (!enableUpgrade && !enableSubstitute) return pairs;

  // 平替主规格「脱销」判定:优先用近一周脱销集(cust_recent_stockout);未提供则回退月度库存 stock_qty===0。
  const isStockout = (id: string): boolean =>
    recentStockoutFreq ? recentStockoutFreq.has(id) : (inventoryById.get(id)?.stock_qty === 0);

  // 写死副规格 id → catalog 解析(6 组配对的主/副规格现已全部录入 categories.json)
  const resolveCat = (id: string): Category | undefined => extendedMap.get(id);

  const isHardcodedPrimary = (id: string): boolean =>
    Object.prototype.hasOwnProperty.call(UPGRADE_PAIRS, id) ||
    Object.prototype.hasOwnProperty.call(SUBSTITUTE_PAIRS, id);

  // 已被用作副规格的 id:避免某规格既当别组主规格又当本组副规格(防链式/重复框)
  const usedSecondaryIds = new Set<string>();
  // 已处理过的 primaryId(specs 可能含重复 id,只配一次)
  const seenPrimary = new Set<string>();

  for (const spec of specs) {
    const pid = spec.id;
    if (seenPrimary.has(pid)) continue;
    seenPrimary.add(pid);
    if (usedSecondaryIds.has(pid)) continue; // 已是别组副规格,不再当主规格

    // 派生候选的排除条件:自身 / 已用作副规格 / 已是某主规格 / 任何写死主规格
    const isExcluded = (id: string): boolean =>
      id === pid || usedSecondaryIds.has(id) || pairs.has(id) || isHardcodedPrimary(id);

    // primary 的扩展视图(specs 通常已是 extendedMap 视图,兜底再查一次)
    const primary = extendedMap.get(pid) ?? spec;

    // 命中即落位并跳过本规格(secondary 须存在且非自身)。
    const trySet = (secondary: Category | undefined, zoneId: 'productUpgrade' | 'substitute', label: string): boolean => {
      if (!secondary || secondary.id === pid) return false;
      pairs.set(pid, { primaryId: pid, secondary, zoneId, boxLabel: label });
      usedSecondaryIds.add(secondary.id);
      return true;
    };

    // ---- 1) 写死配对优先(先于一切派生)----
    // 否则"写死平替主规格恰好也能派生升级"会被升级抢走(如 320512:写死平替→360122,
    // 同时可派生升级→320517);写死优先保证它出平替框。
    // 写死升级:升级款须客户在售,否则不出框、落到下方派生(不推客户没进的货);写死平替维持无条件。
    if (enableUpgrade && UPGRADE_PAIRS[pid]) {
      const sec = resolveCat(UPGRADE_PAIRS[pid]);
      if (sec && onSaleIds.has(sec.id) && trySet(sec, 'productUpgrade', UPGRADE_LABEL)) continue;
    }
    if (enableSubstitute && SUBSTITUTE_PAIRS[pid] && trySet(resolveCat(SUBSTITUTE_PAIRS[pid]), 'substitute', SUBSTITUTE_LABEL)) continue;

    // ---- 2) 自动派生(写死未命中时;升级优先于平替)----
    if (enableUpgrade && trySet(deriveUpgradeSecondary(primary, extendedMap, onSaleIds, isExcluded), 'productUpgrade', UPGRADE_LABEL)) continue;
    if (enableSubstitute && isStockout(pid) &&
        trySet(deriveSubstituteSecondary(primary, extendedMap, onSaleIds, isExcluded), 'substitute', SUBSTITUTE_LABEL)) continue;
  }

  // 产品升级组数封顶(所有客户;写死配对必留,自动派生按**出现序**填到上限)。
  // 出现序 = specs 的排列序 = sortCategories 的推荐排序,即"按推荐排序决定先放哪些组"。
  const upCap = (customerId ? UPGRADE_PAIR_CAP_BY_CUSTOMER[customerId] : undefined) ?? DEFAULT_UPGRADE_PAIR_CAP;
  capUpgradePairs(pairs, upCap);
  // 滞销平替组数封顶(写死平替必留,派生按**季度脱销频次降序**填到上限)。
  capSubstitutePairs(pairs, DEFAULT_SUBSTITUTE_PAIR_CAP, recentStockoutFreq);

  return pairs;
}

/**
 * 把「产品升级」配对就地裁到 cap 组:
 *  - 写死配对(primary 命中 UPGRADE_PAIRS)无条件全保留;
 *  - 其余自动派生升级按 Map 插入序(= 常规陈列出现序)保留,直到达到 cap;
 *  - 超出的自动派生升级从 pairs 删除 —— 其副规格不再被红框圈住,回退为普通包正常陈列。
 * 平替(substitute)配对不计入、不删除。upgrade 配对本就 ≤ cap 时直接返回。
 */
function capUpgradePairs(pairs: Map<string, InlineBoxedPair>, cap: number): void {
  const upgradeIds = [...pairs.entries()]
    .filter(([, p]) => p.zoneId === 'productUpgrade')
    .map(([pid]) => pid);
  if (upgradeIds.length <= cap) return;

  const isHardcoded = (pid: string): boolean =>
    Object.prototype.hasOwnProperty.call(UPGRADE_PAIRS, pid);

  // 保留集合:写死配对全保留(可能 >cap,以业务为先),自动派生按序补到 cap
  const keep = new Set<string>(upgradeIds.filter(isHardcoded));
  for (const pid of upgradeIds) {
    if (keep.size >= cap) break;
    keep.add(pid);  // Set 去重:写死的已在内,这里只新增自动派生
  }

  for (const pid of upgradeIds) {
    if (!keep.has(pid)) pairs.delete(pid);
  }
}

/**
 * 把「滞销平替」配对就地裁到 cap 组:
 *  - 写死平替(primary 命中 SUBSTITUTE_PAIRS)无条件全保留(curated,业务为先);
 *  - 其余自动派生平替按**季度脱销频次(freqById)降序**保留,直到达到 cap —— 频次越高=越常脱销、越该上样平替;
 *    freqById 缺省(回退旧口径)时退化为按 Map 插入序。
 *  - 超出的从 pairs 删除。产品升级(productUpgrade)配对不计入、不删除。
 */
function capSubstitutePairs(
  pairs: Map<string, InlineBoxedPair>,
  cap: number,
  freqById: ReadonlyMap<string, number> | null | undefined,
): void {
  const subIds = [...pairs.entries()]
    .filter(([, p]) => p.zoneId === 'substitute')
    .map(([pid]) => pid);
  if (subIds.length <= cap) return;

  const isHardcoded = (pid: string): boolean =>
    Object.prototype.hasOwnProperty.call(SUBSTITUTE_PAIRS, pid);

  const keep = new Set<string>(subIds.filter(isHardcoded));  // 写死平替全保留
  // 派生平替按季度脱销频次降序(缺频次视为 0);freqById 为空则保持出现序(sort 稳定)
  const derived = subIds.filter(pid => !isHardcoded(pid));
  if (freqById) {
    derived.sort((a, b) => (freqById.get(b) ?? 0) - (freqById.get(a) ?? 0));
  }
  for (const pid of derived) {
    if (keep.size >= cap) break;
    keep.add(pid);
  }

  for (const pid of subIds) {
    if (!keep.has(pid)) pairs.delete(pid);
  }
}

/**
 * 派生升级副规格(高置信口径):同品牌 + 同支型(pack_type) + **同价类(tier)** +
 * **零售价**更贵且价差 ≤ MAX_UPGRADE_PRICE_DIFF(元) + 上市更晚;取上市最新者(tie 价差最小)。
 *  - 比价用零售价(retail_price = dim_category_ext.price/包),与升级明细「每包多赚」同口径;
 *    主规格或候选缺零售价 → 无法比价,跳过(主规格缺价则整体不派生)。
 *  - 同价类 + 价差护栏:确保是同一消费层级内的"贵一点点的新款",挡掉如 南京(红)¥13→南京(软九五)¥100
 *    这类跨档误配;主规格无价类(tier) → 无法确认高置信,不派生。
 *  - 候选仅取客户在售(onSaleIds):升级款必须是客户已进的货,不推没进的货。
 *  - 主规格无上市日期 → 无法判定"更晚",不派生。
 */
function deriveUpgradeSecondary(
  primary: Category,
  extendedMap: ReadonlyMap<string, Category>,
  onSaleIds: ReadonlySet<string>,
  isExcluded: (id: string) => boolean,
): Category | undefined {
  if (!primary.brand) return undefined;
  const pLaunch = primary.launch_date ? Date.parse(primary.launch_date) : NaN;
  if (isNaN(pLaunch)) return undefined;
  const pRetail = primary.retail_price;
  if (pRetail == null) return undefined; // 老品无零售价 → 无法比价,不派生
  const pTier = primary.tier;
  if (!pTier) return undefined; // 老品无价类 → 无法确认同档高置信,不派生
  const pPack = primary.pack_type ?? '';

  let best: Category | undefined;
  let bestLaunch = -Infinity;
  let bestPriceDiff = Infinity;
  for (const id of onSaleIds) {
    const c = extendedMap.get(id);
    if (!c || isExcluded(c.id)) continue;
    if (c.brand !== primary.brand) continue;
    if ((c.pack_type ?? '') !== pPack) continue;
    if (c.tier !== pTier) continue; // 同价类(高置信)
    const cRetail = c.retail_price;
    if (cRetail == null) continue;
    const priceDiff = cRetail - pRetail;
    if (priceDiff <= 0 || priceDiff > MAX_UPGRADE_PRICE_DIFF) continue; // 更贵、且价差在护栏内
    const cLaunch = c.launch_date ? Date.parse(c.launch_date) : NaN;
    if (isNaN(cLaunch) || cLaunch <= pLaunch) continue; // 上市更晚
    if (cLaunch > bestLaunch || (cLaunch === bestLaunch && priceDiff < bestPriceDiff)) {
      best = c;
      bestLaunch = cLaunch;
      bestPriceDiff = priceDiff;
    }
  }
  return best;
}

/**
 * 派生平替副规格:候选 = 客户在售(onSaleIds)规格,按 同品牌 → 同价位段(tier) → 同支型 排序,
 * tie 价格接近;取最优一个。要求最优候选至少有「同品牌 / 同价位段 / 同支型」之一命中,
 * 否则视为无合适平替(不能随便拿个在售烟充数)。
 */
function deriveSubstituteSecondary(
  primary: Category,
  extendedMap: ReadonlyMap<string, Category>,
  onSaleIds: ReadonlySet<string>,
  isExcluded: (id: string) => boolean,
): Category | undefined {
  const pTier = primary.tier ?? '';
  const pPack = primary.pack_type ?? '';

  const candidates: Category[] = [];
  for (const id of onSaleIds) {
    if (isExcluded(id)) continue;
    const c = extendedMap.get(id);
    if (c) candidates.push(c);
  }
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => {
    const aBrand = a.brand === primary.brand ? 0 : 1;
    const bBrand = b.brand === primary.brand ? 0 : 1;
    if (aBrand !== bBrand) return aBrand - bBrand;
    const aTier = (a.tier ?? '') === pTier ? 0 : 1;
    const bTier = (b.tier ?? '') === pTier ? 0 : 1;
    if (aTier !== bTier) return aTier - bTier;
    const aPack = (a.pack_type ?? '') === pPack ? 0 : 1;
    const bPack = (b.pack_type ?? '') === pPack ? 0 : 1;
    if (aPack !== bPack) return aPack - bPack;
    return Math.abs(a.price - primary.price) - Math.abs(b.price - primary.price);
  });

  const best = candidates[0];
  const someMatch =
    best.brand === primary.brand ||
    (best.tier ?? '') === pTier ||
    (best.pack_type ?? '') === pPack;
  return someMatch ? best : undefined;
}
