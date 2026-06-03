"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyIndustrialCoop = classifyIndustrialCoop;
exports.resolveIndustrialCoopUnits = resolveIndustrialCoopUnits;
exports.classifyProductUpgrade = classifyProductUpgrade;
exports.classifySubstitute = classifySubstitute;
exports.classifySlowMoving = classifySlowMoving;
exports.classifyNostalgia = classifyNostalgia;
exports.classifyKeyRecommend = classifyKeyRecommend;
exports.classifyNewProduct = classifyNewProduct;
exports.classifyBeadFlavor = classifyBeadFlavor;
exports.classifyZones = classifyZones;
exports.buildZonePlacements = buildZonePlacements;
exports.buildInlinePairs = buildInlinePairs;
exports.autoExpandZonePlacements = autoExpandZonePlacements;
const types_1 = require("./types");
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
const HIGH_TIER_VALUES = new Set(['一类', '二类']);
/** 爆珠口味组合的 flavor 外层顺序(薄荷>水果>功能性>原味>其他)。 */
const BEAD_FLAVOR_ORDER = ['薄荷', '水果', '功能性', '原味'];
/** 工商共育固定优先顺序;其余 coop 规格按价格降序追加。310143 为新品占位(强制前置)。 */
const INDUSTRIAL_COOP_ORDER = ['310143', '310140', '340136', '450817'];
const INDUSTRIAL_COOP_UNIT_COUNT = 4;
/** 产品升级写死映射(待升级主规格 → 升级副规格),优先级高于通用规则。 */
const UPGRADE_PAIRS = {
    '310133': '310142',
    '310310': '310317',
    '340135': '340142',
};
/** 脱销平替写死映射(脱销主规格 → 在售副规格),优先级高于通用规则。 */
const SUBSTITUTE_PAIRS = {
    '330403': '423801',
    '330409': '310102',
    '320512': '360122',
};
function monthsBetween(from, to) {
    return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}
/** 合成占位 Category：用于 catalog 未收录的工商共育固定 id(如新品 310143)。
 *  imageUrl 仍指向 /images/categories/{id}.jpg,缺图时 imageGen 会画占位框。 */
function placeholderCategory(id) {
    return {
        id,
        name: id,
        imageUrl: `/images/categories/${id}.jpg`,
        price: 0,
        brand: '',
        manufacturer: '',
        category: 'group',
        province: null,
        is_hot: false,
    };
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
/** 工商共育：is_industrial_coop = true 的规格，按品类排序保持稳定。
 *  注:此函数仅供 zonesAvailable 判断"工商共育是否可用",真正的陈列单元由
 *  resolveIndustrialCoopUnits 计算(含固定顺序 + 补满 4 个)。 */
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
 * 工商共育陈列单元:固定首柜前两行,每行「条+3包+条+3包」,共 4 个单元。
 *
 *  候选 = 客户在售的工商共育规格 ∪ 强制占位 310143(新品,暂无数据)。
 *  排序:在 INDUSTRIAL_COOP_ORDER 中的按其顺序优先,其余按价格降序。
 *  取前 4;若不足 4 个,按上述优先级循环复制补满 4 个。
 *  catalog 未收录的 id(如 310143)用 placeholderCategory,imageGen 负责画占位。
 */
function resolveIndustrialCoopUnits(specs, extendedMap) {
    const rank = new Map(INDUSTRIAL_COOP_ORDER.map((id, i) => [id, i]));
    // 候选 id:客户在售 coop 规格 + 强制占位 310143
    const candidateIds = new Set();
    const byId = new Map();
    for (const s of specs) {
        if (s.is_industrial_coop === true) {
            candidateIds.add(s.id);
            byId.set(s.id, s);
        }
    }
    candidateIds.add('310143');
    const list = [];
    for (const id of candidateIds) {
        list.push(extendedMap.get(id) || byId.get(id) || placeholderCategory(id));
    }
    list.sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
        const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
        if (ra !== rb)
            return ra - rb;
        return (b.price ?? 0) - (a.price ?? 0);
    });
    const top = list.slice(0, INDUSTRIAL_COOP_UNIT_COUNT);
    if (top.length === 0)
        return [];
    // 不足 4 个:按优先级循环复制补满
    let i = 0;
    while (top.length < INDUSTRIAL_COOP_UNIT_COUNT) {
        top.push(list[i % list.length]);
        i++;
    }
    return top;
}
/**
 * 产品升级:主规格(待升级)+ 1 个升级副规格,内嵌常规行红框对(grouped 模式,alternatives 长度 1)。
 *
 * 入参:
 *  - specs: 客户陈列池(常规在售品规)。主规格在此池内迭代。
 *  - extendedMap: 全量 catalog,用于解析副规格 Category。
 *  - customerOnSaleIds: 副规格必须在客户库存内(stock_qty>0)才组对——"不加包"原则,副规格须已在陈列。
 *
 * 副规格选择(写死优先 > 通用规则):
 *  - 写死:UPGRADE_PAIRS[primary.id] 存在且其副规格在库存内 → 强制用之;副规格不在库存则该主跳过(不回退通用)。
 *  - 通用:同 brand + 同 pack_type + price 更高 + launch_date 更晚 + 在库存内,取价格增量最小者。
 *
 * 一个规格不会同时充当主与副(used 去重)。
 */
function classifyProductUpgrade(specs, extendedMap, customerOnSaleIds) {
    const result = [];
    const used = new Set();
    for (const primary of specs) {
        if (used.has(primary.id))
            continue;
        let secId;
        if (Object.prototype.hasOwnProperty.call(UPGRADE_PAIRS, primary.id)) {
            // 写死优先且强制:副规格在库存内才用,否则跳过(不回退通用)
            const mapped = UPGRADE_PAIRS[primary.id];
            if (customerOnSaleIds.has(mapped) && !used.has(mapped))
                secId = mapped;
        }
        else {
            // 通用:同品牌 + 同支型 + 价更高 + 上市更晚 + 在库存内,取价格增量最小
            const cands = specs.filter(s => s.id !== primary.id &&
                !used.has(s.id) &&
                customerOnSaleIds.has(s.id) &&
                !!s.brand && s.brand === primary.brand &&
                (s.pack_type ?? '') === (primary.pack_type ?? '') &&
                (s.price ?? 0) > (primary.price ?? 0) &&
                isLaterLaunch(s.launch_date, primary.launch_date));
            cands.sort((a, b) => ((a.price ?? 0) - (primary.price ?? 0)) - ((b.price ?? 0) - (primary.price ?? 0)));
            if (cands.length > 0)
                secId = cands[0].id;
        }
        if (!secId)
            continue;
        const secondary = extendedMap.get(secId);
        if (!secondary)
            continue;
        result.push({ primary: toZoneSpec(primary), alternatives: [toZoneSpec(secondary)] });
        used.add(primary.id);
        used.add(secId);
    }
    return result;
}
/** a 的上市日期是否晚于 b(两者都需为有效日期)。 */
function isLaterLaunch(a, b) {
    if (!a || !b)
        return false;
    const da = new Date(a).getTime();
    const db = new Date(b).getTime();
    if (isNaN(da) || isNaN(db))
        return false;
    return da > db;
}
/**
 * 脱销平替:脱销主规格 + 1 个在售副规格,内嵌常规行红框对(grouped 模式,alternatives 长度 1)。
 *
 * 入参:
 *  - specs: 客户陈列池。主规格必须在此池内(脱销品也在 cust_inventory 内,故在池中)。
 *  - extendedMap: 解析 Category。
 *  - customerOnSaleIds: 副规格必须在库存内(stock_qty>0)——"不加包",副规格须已在陈列。
 *  - rules: Map<脱销 spec_id, 候选 id[]>(已按 rank 升序),来自 ref_co_purchase_rules。
 *  - inventoryById: 候选库存,排序末位用 stock_qty。
 *
 * 副规格选择(写死优先 > 通用规则):
 *  - 写死:SUBSTITUTE_PAIRS[primary.id] 存在且其副规格在库存内 → 强制用之;否则该主跳过(不回退通用)。
 *  - 通用:rules 候选过滤在库存内,按 同品牌 > 价差小 > 同支型 > 库存厚 排序,取 Top1。
 *
 * 候选主规格 = 写死映射 keys ∪ rules keys,且在客户陈列池内。
 */
function classifySubstitute(specs, extendedMap, customerOnSaleIds, rules, inventoryById = new Map()) {
    const specIds = new Set(specs.map(s => s.id));
    const result = [];
    const used = new Set();
    // 写死主规格优先处理(Set 保插入顺序),再处理 rules 主规格
    const primaryIds = new Set([...Object.keys(SUBSTITUTE_PAIRS), ...rules.keys()]);
    for (const pid of primaryIds) {
        if (!specIds.has(pid))
            continue; // 主规格必须在客户陈列池内(不加包)
        if (used.has(pid))
            continue;
        const primary = extendedMap.get(pid);
        if (!primary)
            continue;
        let secId;
        if (Object.prototype.hasOwnProperty.call(SUBSTITUTE_PAIRS, pid)) {
            const mapped = SUBSTITUTE_PAIRS[pid];
            if (customerOnSaleIds.has(mapped) && !used.has(mapped))
                secId = mapped;
        }
        else {
            const candidates = [];
            for (const aid of rules.get(pid) || []) {
                if (used.has(aid))
                    continue;
                if (!customerOnSaleIds.has(aid))
                    continue;
                const cat = extendedMap.get(aid);
                if (cat)
                    candidates.push(cat);
            }
            candidates.sort((a, b) => {
                const aBrand = a.brand === primary.brand ? 0 : 1;
                const bBrand = b.brand === primary.brand ? 0 : 1;
                if (aBrand !== bBrand)
                    return aBrand - bBrand;
                const aDiff = Math.abs((a.price ?? 0) - (primary.price ?? 0));
                const bDiff = Math.abs((b.price ?? 0) - (primary.price ?? 0));
                if (aDiff !== bDiff)
                    return aDiff - bDiff;
                const aPack = (a.pack_type ?? '') === (primary.pack_type ?? '') ? 0 : 1;
                const bPack = (b.pack_type ?? '') === (primary.pack_type ?? '') ? 0 : 1;
                if (aPack !== bPack)
                    return aPack - bPack;
                const aStock = inventoryById.get(a.id)?.stock_qty ?? 0;
                const bStock = inventoryById.get(b.id)?.stock_qty ?? 0;
                return bStock - aStock;
            });
            if (candidates.length > 0)
                secId = candidates[0].id;
        }
        if (!secId)
            continue;
        const secondary = extendedMap.get(secId);
        if (!secondary)
            continue;
        result.push({ primary: toZoneSpec(primary), alternatives: [toZoneSpec(secondary)] });
        used.add(pid);
        used.add(secId);
    }
    return result;
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
function classifyKeyRecommend(specs, extendedMap, customerOnSaleIds, inventoryById) {
    const nostalgiaGroups = classifyNostalgia(specs, extendedMap, customerOnSaleIds);
    const slowMovingSpecs = classifySlowMoving(specs, inventoryById);
    const seen = new Set(nostalgiaGroups.map(g => g.primary.id));
    const slowGroups = [];
    for (const s of slowMovingSpecs) {
        if (seen.has(s.id))
            continue; // 已作为怀旧 primary 出现,不重复
        seen.add(s.id);
        slowGroups.push({ primary: s, alternatives: [] });
    }
    return [...nostalgiaGroups, ...slowGroups];
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
function classifyBeadFlavor(specs) {
    const buckets = new Map();
    for (const spec of specs) {
        if (!(spec.pack_type ?? '').includes('爆珠'))
            continue;
        const flavor = spec.flavor || '其他';
        const list = buckets.get(flavor);
        if (list)
            list.push(spec);
        else
            buckets.set(flavor, [spec]);
    }
    // 组内按 price desc
    for (const list of buckets.values()) {
        list.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
    }
    const result = [];
    // 外层按 BEAD_FLAVOR_ORDER 顺序拼接
    for (const f of BEAD_FLAVOR_ORDER) {
        const list = buckets.get(f);
        if (!list)
            continue;
        for (const s of list) {
            result.push({ id: s.id, name: s.name, imageUrl: s.imageUrl });
        }
    }
    // 兜底:未在 BEAD_FLAVOR_ORDER 中的 flavor(含'其他')排到最后,按 flavor 名字典序稳定
    const tailFlavors = [...buckets.keys()]
        .filter(f => !BEAD_FLAVOR_ORDER.includes(f))
        .sort();
    for (const f of tailFlavors) {
        for (const s of buckets.get(f)) {
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
function classifyZones(specs, extendedMap = new Map(), customerOnSaleIds = new Set(), inventoryById = new Map(), substituteRules = new Map(), now = new Date()) {
    const industrialCoop = classifyIndustrialCoop(specs);
    const productUpgrade = classifyProductUpgrade(specs, extendedMap, customerOnSaleIds);
    const substitute = classifySubstitute(specs, extendedMap, customerOnSaleIds, substituteRules, inventoryById);
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
    // keyRecommend 的滞销组天生 alternatives=[],不可淘汰;其余分组专区空 alternatives 视为无效组
    const keepEmptyAlts = zoneId === 'keyRecommend';
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
        if (alts.length === 0 && !keepEmptyAlts)
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
 * 同一规格作为 primary 时可出现在多个专区(各专区独立计算);分组专区的 alternatives
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
        // 仅 zoneRows 专区占独立行;基础版(fixedTop/inlineRegular)走 generate 专属渲染,不在此落位
        if (meta.layoutKind !== 'zoneRows')
            continue;
        const groups = resolveGroupsForZone(assignment.zone_id, classification, extendedMap, sortedSourceSpecs);
        if (groups.length === 0)
            continue;
        const placement = {
            zoneId: assignment.zone_id,
            label: meta.label,
            counterId: assignment.counter_id,
            rowCount: assignment.row_count,
            groups,
            displayMode: meta.displayMode,
            barColor: meta.barColor,
            priorityRank: meta.priorityRank,
            groupCount: groups.length,
        };
        placements.push(placement);
    }
    return placements;
}
/**
 * 把已启用的 productUpgrade / substitute 分类结果拍平为内嵌红框对(InlinePair[])。
 * 每个 ZoneGroup 的 primary + alternatives[0] 解析为 Category;两端都解析成功才纳入。
 *
 * @param enabledZoneIds 用户在 zone-select 勾选启用的专区 id 集合(基础版按 toggle)
 */
function buildInlinePairs(classification, extendedMap, enabledZoneIds) {
    const out = [];
    const add = (groups, zoneId) => {
        for (const g of groups) {
            const primary = extendedMap.get(g.primary.id);
            const secSpec = g.alternatives[0];
            const secondary = secSpec ? extendedMap.get(secSpec.id) : undefined;
            if (primary && secondary)
                out.push({ primary, secondary, zoneId });
        }
    };
    if (enabledZoneIds.has('productUpgrade'))
        add(classification.productUpgrade, 'productUpgrade');
    if (enabledZoneIds.has('substitute'))
        add(classification.substitute, 'substitute');
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
