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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.allCategoryList = exports.categoryMap = void 0;
exports.getExtendedCategoryMap = getExtendedCategoryMap;
exports.getExtendedCategoryList = getExtendedCategoryList;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const db_1 = __importDefault(require("../db"));
/** 全量品类目录单例：进程启动时加载一次，所有策略/路由共用同一份引用。 */
const categoriesFile = path.join(__dirname, '../data/categories.json');
const baseCategories = JSON.parse(fs.readFileSync(categoriesFile, 'utf-8'));
exports.categoryMap = new Map(baseCategories.map(c => [c.id, c]));
exports.allCategoryList = baseCategories;
let extendedMap = null;
let extendedLoadedAt = 0;
const EXT_CACHE_TTL_MS = 5 * 60 * 1000;
function toDateStr(d) {
    if (!d)
        return null;
    return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}
/**
 * 合并 categories.json 基础字段 + dim_category_ext 扩展字段，5 分钟 TTL 缓存。
 * 表未就绪（ER_NO_SUCH_TABLE）时降级返回纯基础数据，扩展字段保持 undefined。
 * 用于专区策略（滞销 / 怀旧 / 尝鲜）需要 tier / launch_date / is_delisted 等的场景。
 */
async function getExtendedCategoryMap() {
    if (extendedMap && Date.now() - extendedLoadedAt < EXT_CACHE_TTL_MS) {
        return extendedMap;
    }
    const ext = new Map();
    try {
        const [rows] = await db_1.default.execute(`SELECT spec_id, pack_type, flavor, tier, launch_date,
              is_industrial_coop, is_delisted, successor_id
         FROM dim_category_ext`);
        for (const r of rows)
            ext.set(r.spec_id, r);
    }
    catch (err) {
        const code = err.code;
        if (code === 'ER_NO_SUCH_TABLE') {
            console.warn('[categoryCatalog] dim_category_ext not ready, returning base categories');
        }
        else {
            throw err;
        }
    }
    const merged = new Map();
    for (const c of baseCategories) {
        const e = ext.get(c.id);
        merged.set(c.id, e ? {
            ...c,
            pack_type: e.pack_type,
            flavor: e.flavor,
            tier: e.tier,
            launch_date: toDateStr(e.launch_date),
            is_industrial_coop: Boolean(e.is_industrial_coop),
            is_delisted: Boolean(e.is_delisted),
            successor_id: e.successor_id,
        } : c);
    }
    extendedMap = merged;
    extendedLoadedAt = Date.now();
    return merged;
}
async function getExtendedCategoryList() {
    const m = await getExtendedCategoryMap();
    return Array.from(m.values());
}
