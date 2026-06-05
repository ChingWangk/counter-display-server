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
 *  - 写死配对:无条件命中(忽略副规格库存),见 UPGRADE_PAIRS / SUBSTITUTE_PAIRS。
 *  - 自动派生(写死未命中时):
 *    · 升级:同品牌 + 同支型(pack_type) + 副规格更贵(有价差) + 上市更晚;取上市最新(tie 价差最小)。忽略库存。
 *    · 平替:主规格须脱销(stock_qty=0);副规格按 同品牌 → 同价位段(tier) → 同支型 取最优,且强制客户在售。
 *
 * 隔离:产品升级优先于平替;同一 primaryId 不重复配;副规格不得又被当作别组主规格(防链式/重复框)。
 */

/** 产品升级写死配对(主规格编码 → 升级副规格编码)。同品牌、副规格价更高。 */
const UPGRADE_PAIRS: Record<string, string> = {
  '310133': '310142', // 中华(双中支)¥424 → 中华(金双中)¥510
  '310310': '310317', // 牡丹(蓝中支)¥263 → 牡丹(玄华双中)¥339
  '340135': '340142', // 黄山(红方印细支) → 黄山(升级款,待补图)
};

/** 滞销平替写死配对(脱销主规格编码 → 平替副规格编码)。跨品牌、同价位段。 */
const SUBSTITUTE_PAIRS: Record<string, string> = {
  '330421': '423801', // 利群(软蓝)¥159 → 黄鹤楼(软蓝)¥164
  '330409': '310102', // 利群(软长嘴)¥318 → 中华(硬)¥382
  '320512': '360122', // 南京(炫赫门)¥155 → 金圣(青瓷)¥158
};

/**
 * 写死副规格中尚未录入 categories.json 的合成占位(用户后补品名/图片)。
 * imageUrl 命名即生效:上传 /images/categories/{id}.jpg 后 imageGen 的 drawSpec 自动显真图,
 * 在那之前画"未收录"占位包。一旦该 id 进入 dim_category_ext / categories.json,extendedMap 优先生效。
 */
const SYNTHETIC_SECONDARY: Record<string, Category> = {
  '340142': {
    id: '340142',
    name: '黄山(升级款)',
    imageUrl: '/images/categories/340142.jpg',
    price: 0,
    brand: '黄山',
    manufacturer: '',
    category: 'provincial',
    province: null,
    is_hot: false,
  },
};

const UPGRADE_LABEL = '产品升级';
const SUBSTITUTE_LABEL = '滞销平替';

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
  /** spec_id → 库存快照,平替主规格脱销判定(stock_qty === 0)用 */
  inventoryById: ReadonlyMap<string, SpecInventoryInfo>;
}

/**
 * 计算内嵌红框配对。返回 Map<primaryId, InlineBoxedPair>(key = 主规格 id)。
 * 两个专区都未启用 → 返回空 Map。
 */
export function computeInlinePairs(args: ComputeInlinePairsArgs): Map<string, InlineBoxedPair> {
  const { specs, enableUpgrade, enableSubstitute, extendedMap, onSaleIds, inventoryById } = args;
  const pairs = new Map<string, InlineBoxedPair>();
  if (!enableUpgrade && !enableSubstitute) return pairs;

  const resolveCat = (id: string): Category | undefined =>
    extendedMap.get(id) ?? SYNTHETIC_SECONDARY[id];

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

    // ---- 1) 产品升级(优先) ----
    if (enableUpgrade) {
      const hardId = UPGRADE_PAIRS[pid];
      const secondary = hardId
        ? resolveCat(hardId)                                  // 写死:无条件
        : deriveUpgradeSecondary(primary, extendedMap, isExcluded);
      if (secondary && secondary.id !== pid) {
        pairs.set(pid, { primaryId: pid, secondary, zoneId: 'productUpgrade', boxLabel: UPGRADE_LABEL });
        usedSecondaryIds.add(secondary.id);
        continue;
      }
    }

    // ---- 2) 滞销平替(主规格未被升级占用时) ----
    if (enableSubstitute) {
      const hardId = SUBSTITUTE_PAIRS[pid];
      let secondary: Category | undefined;
      if (hardId) {
        secondary = resolveCat(hardId);                        // 写死:无条件(忽略副规格库存)
      } else if (inventoryById.get(pid)?.stock_qty === 0) {    // 派生:主规格须脱销
        secondary = deriveSubstituteSecondary(primary, extendedMap, onSaleIds, isExcluded);
      }
      if (secondary && secondary.id !== pid) {
        pairs.set(pid, { primaryId: pid, secondary, zoneId: 'substitute', boxLabel: SUBSTITUTE_LABEL });
        usedSecondaryIds.add(secondary.id);
        continue;
      }
    }
  }

  return pairs;
}

/**
 * 派生升级副规格:同品牌 + 同支型(pack_type) + 更贵(有价差) + 上市更晚;
 * 取上市最新者(tie 价差最小)。主规格无上市日期 → 无法判定"更晚",不派生。
 */
function deriveUpgradeSecondary(
  primary: Category,
  extendedMap: ReadonlyMap<string, Category>,
  isExcluded: (id: string) => boolean,
): Category | undefined {
  if (!primary.brand) return undefined;
  const pLaunch = primary.launch_date ? Date.parse(primary.launch_date) : NaN;
  if (isNaN(pLaunch)) return undefined;
  const pPack = primary.pack_type ?? '';

  let best: Category | undefined;
  let bestLaunch = -Infinity;
  let bestPriceDiff = Infinity;
  for (const c of extendedMap.values()) {
    if (isExcluded(c.id)) continue;
    if (c.brand !== primary.brand) continue;
    if ((c.pack_type ?? '') !== pPack) continue;
    if (!(c.price > primary.price)) continue; // 升级款更贵
    const cLaunch = c.launch_date ? Date.parse(c.launch_date) : NaN;
    if (isNaN(cLaunch) || cLaunch <= pLaunch) continue; // 上市更晚
    const priceDiff = Math.abs(c.price - primary.price);
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
