"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const imageGen_1 = require("../services/imageGen");
const router = (0, express_1.Router)();
router.post('/', (req, res) => {
    const { counters, categories } = req.body;
    if (!Array.isArray(counters) || counters.length === 0) {
        const body = { success: false, error: '柜台列表不能为空' };
        res.status(400).json(body);
        return;
    }
    if (!Array.isArray(categories) || categories.length === 0) {
        const body = { success: false, error: '品类列表不能为空' };
        res.status(400).json(body);
        return;
    }
    const results = (0, imageGen_1.mockGenerate)(counters);
    const body = { success: true, results };
    res.json(body);
});
exports.default = router;
