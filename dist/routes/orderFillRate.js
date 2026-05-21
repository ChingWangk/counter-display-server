"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
/** GET /api/order-fill-rate — 订足率
 *
 * 同 market-coverage 接口设计：
 *  - spec_ids=...
 *  - order=desc (默认，"短中细爆"专区从高到低)
 *  - limit=N
 */
router.get('/', async (req, res) => {
    const specIdsParam = req.query.spec_ids;
    const order = (req.query.order || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const limit = Math.min(Number(req.query.limit) || 1000, 1000);
    let whereSpec = '';
    const params = [];
    if (specIdsParam) {
        const ids = specIdsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
        if (ids.length === 0) {
            res.json({ success: true, fill_rates: [] });
            return;
        }
        whereSpec = `AND spec_id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
    }
    try {
        const [rows] = await db_1.default.execute(`SELECT spec_id, spec_name, fill_rate, snapshot_month
         FROM ref_order_fill_rate
        WHERE snapshot_month = (SELECT MAX(snapshot_month) FROM ref_order_fill_rate)
              ${whereSpec}
        ORDER BY fill_rate ${order}
        LIMIT ${limit}`, params);
        res.json({
            success: true,
            fill_rates: rows.map(r => ({
                spec_id: r.spec_id,
                spec_name: r.spec_name,
                fill_rate: Number(r.fill_rate),
                snapshot_month: r.snapshot_month,
            })),
        });
    }
    catch (err) {
        const code = err.code;
        if (code === 'ER_NO_SUCH_TABLE') {
            res.json({ success: true, fill_rates: [] });
            return;
        }
        console.error('Query order-fill-rate error:', err);
        res.status(500).json({ success: false, error: '查询失败' });
    }
});
exports.default = router;
