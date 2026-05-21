"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.newCustomerStrategy = void 0;
const db_1 = __importDefault(require("../../db"));
const sortCategories_1 = require("../sortCategories");
const categoryCatalog_1 = require("../categoryCatalog");
const types_1 = require("./types");
/** 高价烟保护阈值：批发价 > 600 元/条 的紧俏烟即便资源不足也保留（门店刚需） */
const HIGH_PRICE_PROTECT = 600;
/**
 * 新客户智能推荐（入网时间 < 3 个月）。
 *
 * 行为与重构前 generate.ts 的 smart 分支完全一致：
 *  1. 客户编号必填
 *  2. 从 customer_specs.spec_detail 读取该客户的主营品规 id 列表
 *  3. 按 sortCategories 排序（集团→省外→外烟）
 *  4. 资源匮乏（specCount > totalSlots）时过滤紧俏烟，但高价烟（price>600）保留
 *
 * 数据依赖：customer_specs 表（旧表，已通过一次性 SQL 从 cust_inventory 回填）。
 */
const newCustomerStrategy = async (ctx) => {
    if (!ctx.customerId) {
        throw new types_1.ValidationError('智能推荐需要客户代码，请先填写');
    }
    const [rows] = await db_1.default.execute('SELECT spec_detail FROM customer_specs WHERE customer_id = ?', [ctx.customerId]);
    if (!rows.length || !rows[0].spec_detail) {
        throw new types_1.ValidationError('后台无数据，请检查所填客户代码是否正确');
    }
    const ids = rows[0].spec_detail.split(',').map((s) => s.trim());
    const usedSpecIds = new Set(ids);
    const pool_ = ids
        .map(id => categoryCatalog_1.categoryMap.get(id))
        .filter((c) => c !== undefined);
    let withImages = (0, sortCategories_1.sortCategories)(pool_);
    let filteredHotSpecs;
    if (withImages.length > ctx.totalSlots) {
        const hotSpecs = withImages.filter(c => c.is_hot && c.price <= HIGH_PRICE_PROTECT);
        if (hotSpecs.length > 0) {
            filteredHotSpecs = hotSpecs.map(c => ({ id: c.id, name: c.name }));
            const removeIds = new Set(hotSpecs.map(c => c.id));
            withImages = withImages.filter(c => !removeIds.has(c.id));
        }
    }
    return {
        specs: withImages,
        usedSpecIds,
        filteredHotSpecs,
    };
};
exports.newCustomerStrategy = newCustomerStrategy;
