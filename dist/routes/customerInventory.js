"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
/** GET /api/customer-inventory/:id — 客户库存快照
 *
 * 查询参数：
 *  - status=stockout    仅返回脱销规格（stock_days = 0）
 *  - status=slow_moving 仅返回滞销规格（stock_days >= 30 AND stock_qty >= 3）
 *  - status=all（默认） 返回全部
 *
 * 取最新 snapshot_date 的数据。
 */
router.get('/:id', async (req, res) => {
    const customerId = req.params.id;
    const status = req.query.status || 'all';
    if (!customerId) {
        res.status(400).json({ success: false, error: '客户编号不能为空' });
        return;
    }
    let whereStatus = '';
    if (status === 'stockout')
        whereStatus = 'AND stock_days = 0';
    else if (status === 'slow_moving')
        whereStatus = 'AND stock_days >= 30 AND stock_qty >= 3';
    try {
        const [rows] = await db_1.default.execute(`SELECT spec_id, stock_qty, stock_days, snapshot_date
         FROM cust_inventory
        WHERE customer_id = ?
          AND snapshot_date = (
            SELECT MAX(snapshot_date) FROM cust_inventory WHERE customer_id = ?
          )
          ${whereStatus}
        ORDER BY stock_days ASC`, [customerId, customerId]);
        res.json({
            success: true,
            inventory: rows.map(r => ({
                spec_id: r.spec_id,
                stock_qty: Number(r.stock_qty),
                stock_days: r.stock_days,
                snapshot_date: r.snapshot_date instanceof Date
                    ? r.snapshot_date.toISOString().slice(0, 10)
                    : r.snapshot_date,
            })),
        });
    }
    catch (err) {
        const code = err.code;
        if (code === 'ER_NO_SUCH_TABLE') {
            res.json({ success: true, inventory: [] });
            return;
        }
        console.error('Query customer-inventory error:', err);
        res.status(500).json({ success: false, error: '查询失败' });
    }
});
exports.default = router;
