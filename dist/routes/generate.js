"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const imageGen_1 = require("../services/imageGen");
const types_1 = require("../services/strategies/types");
const zones_1 = require("../services/strategies/zones");
const festivalSeason_1 = require("../services/strategies/festivalSeason");
const categoryCatalog_1 = require("../services/categoryCatalog");
const manualStrategy_1 = require("../services/strategies/manualStrategy");
const newCustomerStrategy_1 = require("../services/strategies/newCustomerStrategy");
const regularCustomerStrategy_1 = require("../services/strategies/regularCustomerStrategy");
const customerClass_1 = require("../services/customerClass");
const substitute_1 = require("../services/strategies/substitute");
const priceTag_1 = require("../services/priceTag");
const themesFile = path.join(__dirname, '../data/back-cabinet-themes.json');
const allThemes = JSON.parse(fs.readFileSync(themesFile, 'utf-8'));
const IMAGE_PREFIX = '/images/back-themes/';
const router = (0, express_1.Router)();
router.post('/', async (req, res) => {
    try {
        console.log('[DEBUG] 收到 req.body:', JSON.stringify(req.body));
        const { counters, categories, mode = 'manual', customer_id, zone_assignments, } = req.body;
        if (!Array.isArray(counters) || counters.length === 0) {
            const body = { success: false, error: '柜台列表不能为空' };
            res.status(400).json(body);
            return;
        }
        // 按类型分离柜台：前柜/吊柜参与烟包陈列，背柜单独处理
        const displayCounters = counters.filter((c) => c.type === 'front' || c.type === 'hanging');
        const backCounters = counters.filter((c) => c.type === 'back');
        // ---- 拆分 zone_assignments:displayCabinet(前柜/吊柜) vs backCabinet(背柜) ----
        // backCabinet 类目(目前仅 festivalSeason)与其他 zone 的数据流完全隔离 —— 不进 selection,
        // 不进 imageGen,由本路由的背柜分支单独处理。
        const allAssignments = Array.isArray(zone_assignments) ? zone_assignments : [];
        const displayCabinetAssignments = [];
        const backCabinetAssignments = [];
        for (const a of allAssignments) {
            const meta = types_1.ZONE_META[a.zone_id];
            if (!meta)
                continue; // 未知 zone_id 静默忽略(前后端版本不一致时容忍)
            if (meta.targetCabinetType === 'backCabinet') {
                backCabinetAssignments.push(a);
            }
            else {
                displayCabinetAssignments.push(a);
            }
        }
        // 校验 backCabinetAssignments
        for (const a of backCabinetAssignments) {
            const target = backCounters.find((c) => c.id === a.counter_id);
            if (!target) {
                const body = {
                    success: false,
                    error: `专区分配的柜台 ${a.counter_id} 不存在或非背柜`,
                };
                res.status(400).json(body);
                return;
            }
            if (a.zone_id === 'festivalSeason' && !a.festival_id) {
                const body = {
                    success: false,
                    error: `节日季节专区(背柜 ${a.counter_id})缺少 festival_id`,
                };
                res.status(400).json(body);
                return;
            }
        }
        // 陈列资源（前柜+吊柜），smart/manual 共用
        const totalSlots = displayCounters.reduce((sum, c) => {
            return sum + Math.floor(c.length / imageGen_1.PACK_WIDTH_CM) * c.levels;
        }, 0);
        const totalLayerLength = displayCounters.reduce((sum, c) => {
            return sum + c.length * c.levels;
        }, 0);
        // ---- 调度选品策略：manual / newCustomer / regularCustomer 三选一 ----
        const ctx = {
            customerId: customer_id,
            totalSlots,
            totalLayerLength,
            requestCategories: Array.isArray(categories) ? categories : [],
            zoneAssignments: displayCabinetAssignments,
        };
        let selection;
        try {
            if (mode === 'manual') {
                selection = await (0, manualStrategy_1.manualStrategy)(ctx);
            }
            else {
                // mode === 'smart'：按客户类型分发
                const customerClass = await (0, customerClass_1.getCustomerClass)(customer_id || '');
                selection = customerClass === 'regular'
                    ? await (0, regularCustomerStrategy_1.regularCustomerStrategy)(ctx)
                    : await (0, newCustomerStrategy_1.newCustomerStrategy)(ctx);
            }
        }
        catch (err) {
            if (err instanceof types_1.ValidationError) {
                const body = { success: false, error: err.message };
                res.status(400).json(body);
                return;
            }
            throw err;
        }
        const specs = selection.specs;
        const usedSpecIds = selection.usedSpecIds;
        const filteredHotSpecs = selection.filteredHotSpecs || [];
        const initialZonePlacements = selection.zonePlacements || [];
        // ---- 校验初始 zonePlacements 落位的柜台合法 ----
        for (const p of initialZonePlacements) {
            const target = displayCounters.find((c) => c.id === p.counterId);
            if (!target) {
                const body = {
                    success: false,
                    error: `专区分配的柜台 ${p.counterId} 不存在或非前柜/吊柜`,
                };
                res.status(400).json(body);
                return;
            }
        }
        // ---- 顺序分配 regular specs:假设无 zone,前置柜台先吃满 ----
        // 业务规则:常规陈列先沿前置柜台铺满,被常规填满的层不允许放置专区。
        const specCount = specs.length;
        const allocations = [];
        const regularRowsByCounter = new Map();
        let remaining = specCount;
        for (const c of displayCounters) {
            const packsPerRow = Math.floor(c.length / imageGen_1.PACK_WIDTH_CM);
            const cap = packsPerRow * c.levels;
            const used = Math.min(remaining, cap);
            allocations.push(used);
            remaining -= used;
            regularRowsByCounter.set(c.id, packsPerRow > 0 ? Math.min(c.levels, Math.ceil(used / packsPerRow)) : 0);
        }
        // ---- 校验:用户分配的 zone 行数必须落在「常规之外的空闲层」内 ----
        const initialZoneRowsByCounter = new Map();
        for (const p of initialZonePlacements) {
            initialZoneRowsByCounter.set(p.counterId, (initialZoneRowsByCounter.get(p.counterId) || 0) + p.rowCount);
        }
        for (const c of displayCounters) {
            const zRows = initialZoneRowsByCounter.get(c.id) || 0;
            const regRows = regularRowsByCounter.get(c.id) || 0;
            const freeRows = c.levels - regRows;
            if (zRows > freeRows) {
                const body = {
                    success: false,
                    error: `柜台 ${c.id} 仅剩 ${freeRows} 行可放专区,无法容纳 ${zRows} 行`,
                };
                res.status(400).json(body);
                return;
            }
        }
        // ---- 自动扩展:把每个柜台剩余空行用已启用的专区填满(groupCount 优先,上限即柜台空闲层数) ----
        const zonePlacements = (0, zones_1.autoExpandZonePlacements)(initialZonePlacements, displayCounters, regularRowsByCounter);
        // ---- 拉价签白名单:根据 cust_info.has_pos 决定 ref_yangpu_avg_price 子集 ----
        // 有 customer_id 才有比对依据;无 customer_id 时空 Map,imageGen 不画价签。
        let priceTagMap = new Map();
        if (customer_id) {
            const hasPos = await (0, substitute_1.getCustomerHasPos)(customer_id);
            priceTagMap = await (0, priceTag_1.getPriceTagMap)(hasPos);
        }
        // ---- 逐柜台生成图片 ----
        const results = [];
        let offset = 0;
        for (let i = 0; i < displayCounters.length; i++) {
            const cabinet = displayCounters[i];
            const cabinetSpecs = specs.slice(offset, offset + allocations[i]);
            const cabinetZones = zonePlacements.filter(p => p.counterId === cabinet.id);
            // zone usedSpecIds 也要并入,用于背柜主题匹配:遍历 groups 收集 primary + alternatives
            for (const p of cabinetZones) {
                for (const g of p.groups) {
                    usedSpecIds.add(g.primary.id);
                    for (const a of g.alternatives)
                        usedSpecIds.add(a.id);
                }
            }
            const regRows = regularRowsByCounter.get(cabinet.id) || 0;
            const { imageUrl } = await (0, imageGen_1.generateCounterImage)(cabinet, cabinetSpecs, regRows, cabinetZones, priceTagMap);
            results.push({
                counterId: cabinet.id,
                counterType: cabinet.type,
                imageUrl,
            });
            offset += allocations[i];
        }
        // ---- 背柜:节日季节专区优先(单图直出);未命中节日的背柜走主题图逻辑 ----
        // 节日命中的背柜跳过 back-cabinet-select 主题匹配,跟用户在 zone-select 上的"节日优先"约定一致。
        const festivalByBackCounter = new Map();
        for (const a of backCabinetAssignments) {
            if (a.zone_id === 'festivalSeason' && a.festival_id) {
                festivalByBackCounter.set(a.counter_id, a.festival_id);
            }
        }
        let extendedMap = null;
        if (festivalByBackCounter.size > 0) {
            extendedMap = await (0, categoryCatalog_1.getExtendedCategoryMap)();
        }
        const customerSpecIds = new Set(specs.map((c) => c.id));
        const matchedThemes = allThemes.filter(t => t.specIds.some(id => usedSpecIds.has(id)));
        const allThemeImages = matchedThemes.flatMap(t => t.images.map(img => IMAGE_PREFIX + img));
        for (const counter of backCounters) {
            const festivalId = festivalByBackCounter.get(counter.id);
            if (festivalId && extendedMap) {
                const festivalUrl = await (0, festivalSeason_1.selectFestivalImage)(festivalId, customerSpecIds, extendedMap, new Date());
                if (festivalUrl) {
                    results.push({
                        counterId: counter.id,
                        counterType: counter.type,
                        imageUrl: festivalUrl,
                        layerImages: [festivalUrl],
                    });
                    continue;
                }
                // 选不到图(目录空 / 候选与客户无交集): 降级走主题图逻辑
            }
            const layerImages = [];
            for (let li = 0; li < counter.levels; li++) {
                if (allThemeImages.length > 0) {
                    layerImages.push(allThemeImages[li % allThemeImages.length]);
                }
            }
            results.push({
                counterId: counter.id,
                counterType: counter.type,
                imageUrl: layerImages.length > 0 ? layerImages[0] : 'mock:back',
                layerImages,
            });
        }
        // ---- 合并 festivalSeason 的 ZonePlacement 到响应 zonePlacements ----
        // selection 不知道 festivalSeason 的存在,这里单独构造占位 placement 供前端 result chip 展示。
        const festivalPlacements = [];
        const festivalMeta = types_1.ZONE_META.festivalSeason;
        for (const a of backCabinetAssignments) {
            if (a.zone_id === 'festivalSeason' && a.festival_id) {
                festivalPlacements.push({
                    zoneId: 'festivalSeason',
                    label: festivalMeta.label,
                    counterId: a.counter_id,
                    rowCount: 1,
                    groups: [],
                    displayMode: 'backFestival',
                    barColor: festivalMeta.barColor,
                    priorityRank: festivalMeta.priorityRank,
                    groupCount: 1,
                });
            }
        }
        const allZonePlacements = [...zonePlacements, ...festivalPlacements];
        const body = {
            success: true,
            results,
            ...(filteredHotSpecs.length > 0 ? { filteredHotSpecs } : {}),
            ...(allZonePlacements.length > 0 ? { zonePlacements: allZonePlacements } : {}),
        };
        res.json(body);
    }
    catch (err) {
        console.error('Generate error:', err);
        const message = err instanceof Error ? err.message : '图片生成失败';
        const body = { success: false, error: message };
        res.status(500).json(body);
    }
});
exports.default = router;
