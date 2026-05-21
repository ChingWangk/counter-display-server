"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyIndustrialCoop = classifyIndustrialCoop;
exports.classifyProductUpgrade = classifyProductUpgrade;
exports.classifySubstitute = classifySubstitute;
exports.classifySlowMoving = classifySlowMoving;
exports.classifyNostalgia = classifyNostalgia;
exports.classifyNewProduct = classifyNewProduct;
exports.classifyZones = classifyZones;
exports.buildZonePlacements = buildZonePlacements;
exports.autoExpandZonePlacements = autoExpandZonePlacements;
const types_1 = require("./types");
/**
 * 6 个低成本专区分类器。
 * 纯函数：入参为只读数据结构，出参为新数组，无副作用，可独立单测。
 *
 * 展示模式分两类:
 *  - single  : 单品陈列(每包紧贴),工商共育 / 滞销夸夸角 / 尝鲜专区
 *  - grouped : 分组陈列(primary + 每个 alternative 均单包,组与组之间留 gap),平替专区 / 怀旧专区 / 产品升级
 *
 * - classifyIndustrialCoop: 工商共育,is_industrial_coop = true                            → ZoneSpec[]
 * - classifyProductUpgrade: 产品升级,上海集团新品+同产地/同品牌的集团紧俏 Top 2           → ZoneGroup[]
 * - classifySubstitute:    平替专区, 脱销→Top N 平替组合(alternatives 必须在客户在售)    → ZoneGroup[]
 * - classifySlowMoving:    滞销夸夸角,stock_days ≥ 30 且 stock_qty ≥ 3                    → ZoneSpec[]
 * - classifyNostalgia:     怀旧专区, is_delisted = true && successor 在客户在售          → ZoneGroup[]
 * - classifyNewProduct:    尝鲜专区, launch_date 在窗口期(一/二类 24 月,其他 12 月)      → ZoneSpec[]
 * - classifyZones:         一次性返回六专区结果(已按 primary id 优先级 dedupe)
 *
 * Dedupe 规则:一个 spec 最多作为 primary 归属一个专区,按优先级
 * industrialCoop > productUpgrade > substitute > slowMoving > nostalgia > newProduct 先到先得。
 * 分组专区的 alternatives 不参与 dedupe(允许跨专区出现)。
 */
const SLOW_MOVING_DAYS = 30;
const SLOW_MOVING_QTY = 3;
const HIGH_TIER_NEW_MONTHS = 24;
const DEFAULT_NEW_MONTHS = 12;
const SHANGHAI_TOBACCO_MFR = '上海烟草集团有限责任公司';
const HIGH_TIER_VALUES = new Set(['一类', '二类']);
function monthsBetween(from, to) {
    return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}
function toZoneSpec(c) {
    return {
        id: c.id,
        name: c.name,
        imageUrl: c.imageUrl,
        successor_id: c.successor_id ?? null,
        launch_date: c.launch_date ?? null,
    };
}
/** 工商共育：is_industrial_coop = true 的规格，按品类排序保持稳定。 */
function classifyIndustrialCoop(specs) {
    const result = [];
    for (const spec of specs) {
        if (spec.is_industrial_coop !== true)
            continue;
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
function classifyProductUpgrade(specs, extendedMap, customerOnSaleIds, now = new Date()) {
    // alt 候选池:上海集团 + is_hot + 在客户在售
    const altCandidates = [];
    for (const c of extendedMap.values()) {
        if (c.manufacturer !== SHANGHAI_TOBACCO_MFR)
            continue;
        if (c.is_hot !== true)
            continue;
        if (!customerOnSaleIds.has(c.id))
            continue;
        altCandidates.push(c);
    }
    const fullGroups = [];
    const partialGroups = [];
    for (const primary of specs) {
        if (primary.manufacturer !== SHANGHAI_TOBACCO_MFR)
            continue;
        if (!primary.launch_date)
            continue;
        const launch = new Date(primary.launch_date);
        if (isNaN(launch.getTime()))
            continue;
        const months = monthsBetween(launch, now);
        if (months < 0)
            continue;
        const window = HIGH_TIER_VALUES.has(primary.tier ?? '') ? HIGH_TIER_NEW_MONTHS : DEFAULT_NEW_MONTHS;
        if (months > window)
            continue;
        // 业务多准则排序(同产地 > 同品牌 > 价格接近),tie 时保留 extendedMap 顺序
        const sorted = altCandidates
            .filter(c => c.id !== primary.id)
            .slice()
            .sort((a, b) => {
            const aProv = a.province === primary.province ? 0 : 1;
            const bProv = b.province === primary.province ? 0 : 1;
            if (aProv !== bProv)
                return aProv - bProv;
            const aBrand = a.brand === primary.brand ? 0 : 1;
            const bBrand = b.brand === primary.brand ? 0 : 1;
            if (aBrand !== bBrand)
                return aBrand - bBrand;
            const aPriceDiff = Math.abs((a.price ?? 0) - (primary.price ?? 0));
            const bPriceDiff = Math.abs((b.price ?? 0) - (primary.price ?? 0));
            return aPriceDiff - bPriceDiff;
        });
        if (sorted.length === 0)
            continue;
        const top = sorted.slice(0, 2);
        const group = {
            primary: toZoneSpec(primary),
            alternatives: top.map(toZoneSpec),
        };
        if (top.length >= 2)
            fullGroups.push(group);
        else
            partialGroups.push(group);
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
function classifySubstitute(extendedMap, customerOnSaleIds, rules, inventoryById = new Map()) {
    const fullGroups = [];
    const partialGroups = [];
    for (const [primaryId, candidateIds] of rules) {
        const primary = extendedMap.get(primaryId);
        if (!primary)
            continue;
        // 1. 过滤候选:在客户在售集合内 + 在 extendedMap 中有 Category
        const candidates = [];
        for (const aid of candidateIds) {
            if (!customerOnSaleIds.has(aid))
                continue;
            const cat = extendedMap.get(aid);
            if (cat)
                candidates.push(cat);
        }
        if (candidates.length === 0)
            continue; // 无在售替代 → 整组淘汰
        // 2. 业务多准则排序
        candidates.sort((a, b) => {
            const aPriceDiff = Math.abs((a.price ?? 0) - (primary.price ?? 0));
            const bPriceDiff = Math.abs((b.price ?? 0) - (primary.price ?? 0));
            if (aPriceDiff !== bPriceDiff)
                return aPriceDiff - bPriceDiff;
            const aProv = a.province === primary.province ? 0 : 1;
            const bProv = b.province === primary.province ? 0 : 1;
            if (aProv !== bProv)
                return aProv - bProv;
            const aPack = (a.pack_type ?? '') === (primary.pack_type ?? '') ? 0 : 1;
            const bPack = (b.pack_type ?? '') === (primary.pack_type ?? '') ? 0 : 1;
            if (aPack !== bPack)
                return aPack - bPack;
            const aStock = inventoryById.get(a.id)?.stock_qty ?? 0;
            const bStock = inventoryById.get(b.id)?.stock_qty ?? 0;
            return bStock - aStock;
        });
        // 3. 业务排序后取 Top 2
        const top = candidates.slice(0, 2);
        const group = {
            primary: toZoneSpec(primary),
            alternatives: top.map(toZoneSpec),
        };
        // 4. 完整组(2 个替代)与残缺组(1 个替代)分桶,残缺组放到末尾
        if (top.length >= 2)
            fullGroups.push(group);
        else
            partialGroups.push(group);
    }
    return [...fullGroups, ...partialGroups];
}
/** 滞销夸夸角：积压库存 ≥ 30 天且数量 ≥ 3 条的规格，按 stock_days 降序。 */
function classifySlowMoving(specs, inventoryById) {
    const result = [];
    for (const spec of specs) {
        const inv = inventoryById.get(spec.id);
        if (!inv)
            continue;
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
function classifyNostalgia(specs, extendedMap, customerOnSaleIds) {
    const result = [];
    for (const spec of specs) {
        if (spec.is_delisted !== true)
            continue;
        const successorId = spec.successor_id ?? null;
        if (!successorId)
            continue;
        if (!customerOnSaleIds.has(successorId))
            continue;
        const successor = extendedMap.get(successorId);
        if (!successor)
            continue;
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
function classifyNewProduct(specs, now = new Date()) {
    const result = [];
    for (const spec of specs) {
        if (!spec.launch_date)
            continue;
        const launch = new Date(spec.launch_date);
        if (isNaN(launch.getTime()))
            continue;
        const months = monthsBetween(launch, now);
        if (months < 0)
            continue; // 未来上市日期忽略
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
 * 一次性运行 6 个分类器并按 primary id 优先级 dedupe。
 *
 * 优先级:industrialCoop > productUpgrade > substitute > slowMoving > nostalgia > newProduct。
 * 同一规格在多个专区命中(作为 primary)时,仅保留在第一个命中的专区中。
 *
 * 缺省参数:
 *  - inventoryById 空 → slowMoving 自然返回 []
 *  - substituteRules 空 → substitute 返回 []
 *  - customerOnSaleIds 空 → substitute / nostalgia / productUpgrade 因 alternatives 在售校验失败而返回 []
 *  - extendedMap 空 → substitute / nostalgia / productUpgrade 无法查 primary/alternatives 而返回 []
 */
function classifyZones(specs, extendedMap = new Map(), customerOnSaleIds = new Set(), inventoryById = new Map(), substituteRules = new Map(), now = new Date()) {
    const usedPrimary = new Set();
    const industrialCoop = classifyIndustrialCoop(specs);
    industrialCoop.forEach(s => usedPrimary.add(s.id));
    // productUpgrade 在 industrialCoop 之后 dedupe(同 rank=1):上海集团新品优先归入 productUpgrade,
    // 不再以 single 形式出现在 newProduct
    const productUpgradeRaw = classifyProductUpgrade(specs, extendedMap, customerOnSaleIds, now);
    const productUpgrade = productUpgradeRaw.filter(g => !usedPrimary.has(g.primary.id));
    productUpgrade.forEach(g => usedPrimary.add(g.primary.id));
    // substitute 的 primary 是脱销规格,可能不在 specs(客户在售)中,但需要参与 dedupe
    const substituteRaw = classifySubstitute(extendedMap, customerOnSaleIds, substituteRules, inventoryById);
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
    return { industrialCoop, productUpgrade, substitute, slowMoving, nostalgia, newProduct };
}
/**
 * 单品专区:从 sortedSourceSpecs 中按 ids 过滤出 Category 列表,包装为单品 group(alternatives=[])。
 * 分组专区:把 ZoneGroup 的 primary / alternatives 从 extendedMap 解析为 Category。
 */
function resolveGroupsForZone(zoneId, classification, extendedMap, sortedSourceSpecs) {
    const meta = types_1.ZONE_META[zoneId];
    // festivalSeason 数据流隔离,不进 classification;buildZonePlacements 调用方已过滤,此处仅防御
    if (meta.displayMode === 'backFestival')
        return [];
    const clsKey = zoneId;
    if (meta.displayMode === 'single') {
        const specs = classification[clsKey];
        const idSet = new Set(specs.map(s => s.id));
        // 沿 sortedSourceSpecs 的顺序输出,保留 manual 模式下的重复
        return sortedSourceSpecs
            .filter(c => idSet.has(c.id))
            .map(c => ({ primary: c, alternatives: [] }));
    }
    // grouped
    const groups = classification[clsKey];
    const out = [];
    for (const g of groups) {
        const primary = extendedMap.get(g.primary.id);
        if (!primary)
            continue;
        const alts = [];
        for (const a of g.alternatives) {
            const cat = extendedMap.get(a.id);
            if (cat)
                alts.push(cat);
        }
        if (alts.length === 0)
            continue;
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
function buildZonePlacements(classification, assignments, sortedSourceSpecs, extendedMap) {
    const placements = [];
    for (const assignment of assignments) {
        const meta = types_1.ZONE_META[assignment.zone_id];
        if (!meta)
            continue;
        const groups = resolveGroupsForZone(assignment.zone_id, classification, extendedMap, sortedSourceSpecs);
        if (groups.length === 0)
            continue;
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
function autoExpandZonePlacements(placements, cabinets, regularRowsByCounter) {
    // 浅拷贝每个 placement,避免修改入参
    const cloned = placements.map(p => ({ ...p }));
    const byCounter = new Map();
    for (const p of cloned) {
        const arr = byCounter.get(p.counterId) || [];
        arr.push(p);
        byCounter.set(p.counterId, arr);
    }
    for (const cabinet of cabinets) {
        const zones = byCounter.get(cabinet.id);
        if (!zones || zones.length === 0)
            continue;
        const regularRows = regularRowsByCounter.get(cabinet.id) || 0;
        const currentZoneRows = zones.reduce((s, z) => s + z.rowCount, 0);
        let leftover = Math.max(0, cabinet.levels - regularRows - currentZoneRows);
        if (leftover <= 0)
            continue;
        // groupCount 高 → 优先获得额外行;轮询直至 leftover 用完
        const sorted = [...zones].sort((a, b) => b.groupCount - a.groupCount);
        while (leftover > 0) {
            let progressed = false;
            for (const z of sorted) {
                if (leftover === 0)
                    break;
                z.rowCount = z.rowCount + 1;
                leftover--;
                progressed = true;
            }
            if (!progressed)
                break;
        }
    }
    return cloned;
}
