"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const categoryCatalog_1 = require("../services/categoryCatalog");
const router = (0, express_1.Router)();
/**
 * GET /api/categories — 返回 categories.json + dim_category_ext 合并后的全量品类。
 * 合并逻辑与缓存集中在 services/categoryCatalog.ts，策略模块也使用同一份缓存。
 */
router.get('/', async (_req, res) => {
    try {
        const categories = await (0, categoryCatalog_1.getExtendedCategoryList)();
        res.json({ success: true, categories });
    }
    catch (err) {
        console.error('Query categories error:', err);
        res.status(500).json({ success: false, error: '查询失败' });
    }
});
exports.default = router;
