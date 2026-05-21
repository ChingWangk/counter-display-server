"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
/** GET /api/customer-counters/:id — 返回客户的柜台配置
 *
 * 用于前端 counter-config 页面：用户输入客户编号后，
 * 自动从 cust_counters 表回填柜台列表（按 sort_order 排序）。
 *
 * Fallback：客户无柜台记录 → 返回空数组（让前端走"手工添加"流程）。
 */
router.get('/:id', async (req, res) => {
    const customerId = req.params.id;
    if (!customerId) {
        res.status(400).json({ success: false, error: '客户编号不能为空' });
        return;
    }
    try {
        const [rows] = await db_1.default.execute(`SELECT customer_id, counter_id, type, length, levels, sort_order
         FROM cust_counters
        WHERE customer_id = ?
        ORDER BY sort_order ASC`, [customerId]);
        res.json({
            success: true,
            counters: rows.map(r => ({
                id: r.counter_id,
                type: r.type,
                length: r.length,
                levels: r.levels,
                sortOrder: r.sort_order,
            })),
        });
    }
    catch (err) {
        const code = err.code;
        if (code === 'ER_NO_SUCH_TABLE') {
            console.warn('[customer-counters] table not ready, returning empty');
            res.json({ success: true, counters: [] });
            return;
        }
        console.error('Query customer-counters error:', err);
        res.status(500).json({ success: false, error: '查询失败' });
    }
});
exports.default = router;
