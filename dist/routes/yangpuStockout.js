"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
/** GET /api/yangpu-stockout — 杨浦区脱销规格清单（挖掘产出）
 *
 * 口径：上季度卖过该规格的 POS 商户里，当前盘点为 0 的占比 > 30%（且 sellers_count ≥ 5）。
 * 主要用途：无 POS 客户分支用于品类决策（剔除/降权）。
 *
 * 查询参数：
 *  - min_rate 可选，默认不再过滤（库表已过滤）；传 0.5 等可二次收紧
 */
router.get('/', async (req, res) => {
    const minRate = Number(req.query.min_rate);
    const whereFilter = Number.isFinite(minRate) && minRate > 0 ? 'WHERE stockout_rate >= ?' : '';
    const params = Number.isFinite(minRate) && minRate > 0 ? [minRate] : [];
    try {
        const [rows] = await db_1.default.execute(`SELECT spec_id, spec_name, sellers_count, stockout_count, stockout_rate, snapshot_date
         FROM ref_yangpu_stockout
         ${whereFilter}
        ORDER BY stockout_rate DESC, sellers_count DESC`, params);
        res.json({
            success: true,
            stockouts: rows.map(r => ({
                spec_id: r.spec_id,
                spec_name: r.spec_name,
                sellers_count: r.sellers_count,
                stockout_count: r.stockout_count,
                stockout_rate: Number(r.stockout_rate),
                snapshot_date: r.snapshot_date,
            })),
        });
    }
    catch (err) {
        const code = err.code;
        if (code === 'ER_NO_SUCH_TABLE') {
            res.json({ success: true, stockouts: [] });
            return;
        }
        console.error('Query yangpu-stockout error:', err);
        res.status(500).json({ success: false, error: '查询失败' });
    }
});
exports.default = router;
