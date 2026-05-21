"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
/** GET /api/yangpu-avg-price — 杨浦区平均售价 + 价签白名单
 *
 * 查询参数：
 *  - has_pos=1 仅返回 POS 客户应显示的（7 个规格）
 *  - has_pos=0 仅返回无 POS 客户应显示的（前 3 个）
 *  - 不传    全部返回
 *
 * 取最新 snapshot_month。
 */
router.get('/', async (req, res) => {
    const hasPos = req.query.has_pos;
    let whereFilter = '';
    if (hasPos === '1')
        whereFilter = 'AND show_for_pos = 1';
    else if (hasPos === '0')
        whereFilter = 'AND show_for_nopos = 1';
    try {
        const [rows] = await db_1.default.execute(`SELECT spec_id, spec_name, avg_price, show_for_pos, show_for_nopos, snapshot_month
         FROM ref_yangpu_avg_price
        WHERE snapshot_month = (SELECT MAX(snapshot_month) FROM ref_yangpu_avg_price)
              ${whereFilter}
        ORDER BY avg_price DESC`);
        res.json({
            success: true,
            prices: rows.map(r => ({
                spec_id: r.spec_id,
                spec_name: r.spec_name,
                avg_price: Number(r.avg_price),
                show_for_pos: Boolean(r.show_for_pos),
                show_for_nopos: Boolean(r.show_for_nopos),
                snapshot_month: r.snapshot_month,
            })),
        });
    }
    catch (err) {
        const code = err.code;
        if (code === 'ER_NO_SUCH_TABLE') {
            res.json({ success: true, prices: [] });
            return;
        }
        console.error('Query yangpu-avg-price error:', err);
        res.status(500).json({ success: false, error: '查询失败' });
    }
});
exports.default = router;
