"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const categoryCatalog_1 = require("../services/categoryCatalog");
const zones_1 = require("../services/strategies/zones");
const substitute_1 = require("../services/strategies/substitute");
const festivalSeason_1 = require("../services/strategies/festivalSeason");
const types_1 = require("../services/strategies/types");
const router = (0, express_1.Router)();
router.post('/', async (req, res) => {
    try {
        const { customer_id, categories, mode } = (req.body || {});
        if (mode !== 'smart' && mode !== 'manual') {
            res.status(400).json({ success: false, error: 'mode 必须为 smart 或 manual' });
            return;
        }
        // ---- 1. 准备 source spec 列表 + inventory ----
        const extendedMap = await (0, categoryCatalog_1.getExtendedCategoryMap)();
        let sourceSpecs = [];
        let inventoryById = new Map();
        if (mode === 'smart') {
            if (!customer_id) {
                res.status(400).json({ success: false, error: 'smart 模式需要 customer_id' });
                return;
            }
            const [rows] = await db_1.default.execute(`
        SELECT t.spec_id, t.stock_qty, t.stock_days, t.snapshot_date
        FROM cust_inventory t
        INNER JOIN (
          SELECT spec_id, MAX(snapshot_date) AS max_date
          FROM cust_inventory
          WHERE customer_id = ?
          GROUP BY spec_id
        ) m ON t.spec_id = m.spec_id AND t.snapshot_date = m.max_date
        WHERE t.customer_id = ?
        `, [customer_id, customer_id]);
            for (const r of rows) {
                const snapshotStr = r.snapshot_date instanceof Date
                    ? r.snapshot_date.toISOString().slice(0, 10)
                    : String(r.snapshot_date).slice(0, 10);
                inventoryById.set(r.spec_id, {
                    spec_id: r.spec_id,
                    stock_qty: Number(r.stock_qty),
                    stock_days: Number(r.stock_days),
                    snapshot_date: snapshotStr,
                });
                const c = extendedMap.get(r.spec_id);
                if (c)
                    sourceSpecs.push(c);
            }
        }
        else {
            // manual:用前端传入的 categories(只需要 id),通过 extendedMap 合并 ext 字段
            if (!Array.isArray(categories) || categories.length === 0) {
                res.json({ success: true, zones: [], customerSpecCount: 0 });
                return;
            }
            // 去重 id,manual 模式同一品类可能被多次选中
            const uniqueIds = Array.from(new Set(categories.map(c => c.id)));
            for (const id of uniqueIds) {
                const c = extendedMap.get(id);
                if (c)
                    sourceSpecs.push(c);
            }
        }
        // 客户总品规数(用于前端计算每柜台最多可分配的专区行数):
        // smart 模式 = cust_inventory 去重 spec 数; manual 模式 = 用户勾选总数(含重复,即陈列包数)
        const customerSpecCount = mode === 'smart'
            ? sourceSpecs.length
            : (categories?.length ?? 0);
        // ---- 2. 拉平替候选 spec_id_a→spec_id_b[] 映射（仅 smart + 有 customer_id 时生效）----
        let substituteRules = new Map();
        if (mode === 'smart' && customer_id) {
            const hasPos = await (0, substitute_1.getCustomerHasPos)(customer_id);
            substituteRules = await (0, substitute_1.fetchSubstituteRules)(customer_id, hasPos);
        }
        // ---- 3. 分类 + dedupe ----
        const customerOnSaleIds = new Set(sourceSpecs.map(c => c.id));
        const zoneCls = (0, zones_1.classifyZones)(sourceSpecs, extendedMap, customerOnSaleIds, inventoryById, substituteRules);
        // ---- 4. 转换为 AvailableZone[],只保留 groupCount > 0 ----
        const result = [];
        for (const zoneId of types_1.ZONE_PRIORITY_ORDER) {
            const meta = types_1.ZONE_META[zoneId];
            if (meta.displayMode === 'backFestival') {
                // 节日季节专区:数据流与其他 zone 完全隔离,这里仅判定"是否有图片素材且客户至少 1 张候选"
                if (!(0, festivalSeason_1.hasFestivalCandidates)(customerOnSaleIds))
                    continue;
                result.push({
                    ...meta,
                    groupCount: 1, // 占位 — 实际按节日单图直出,前端 zone-select 不依赖此数
                    specs: [],
                });
                continue;
            }
            // 走 classification 表查询:此分支下 zoneId 必属于 ZoneClassification 字段
            const clsKey = zoneId;
            if (meta.displayMode === 'single') {
                const specs = zoneCls[clsKey];
                if (specs.length === 0)
                    continue;
                result.push({
                    ...meta,
                    groupCount: specs.length,
                    specs,
                });
            }
            else {
                const groups = zoneCls[clsKey];
                if (groups.length === 0)
                    continue;
                result.push({
                    ...meta,
                    groupCount: groups.length,
                    specs: groups.map(g => g.primary), // 卡片预览用 primary 列表
                    groups,
                });
            }
        }
        res.json({ success: true, zones: result, customerSpecCount });
    }
    catch (err) {
        console.error('zones/available error:', err);
        const message = err instanceof Error ? err.message : '获取专区失败';
        res.status(500).json({ success: false, error: message });
    }
});
exports.default = router;
