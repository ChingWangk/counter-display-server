"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
/** GET /api/wholesale-rank — 高价烟季度批发量排名（礼盒精品专区）
 *
 * 查询参数：
 *  - year=2026 quarter=1   指定季度（默认最新）
 *  - top=20                返回 Top N（默认全部）
 */
router.get('/', async (req, res) => {
    const yearParam = req.query.year;
    const quarterParam = req.query.quarter;
    const top = Math.min(Number(req.query.top) || 1000, 1000);
    try {
        let year;
        let quarter;
        if (yearParam && quarterParam) {
            year = Number(yearParam);
            quarter = Number(quarterParam);
        }
        else {
            const [latest] = await db_1.default.execute(`SELECT year, quarter FROM ref_quarterly_wholesale_rank
          ORDER BY year DESC, quarter DESC LIMIT 1`);
            if (latest.length === 0) {
                res.json({ success: true, year: null, quarter: null, ranks: [] });
                return;
            }
            year = latest[0].year;
            quarter = latest[0].quarter;
        }
        const [rows] = await db_1.default.execute(`SELECT spec_id, spec_name, year, quarter, wholesale_qty, rank_in_quarter
         FROM ref_quarterly_wholesale_rank
        WHERE year = ? AND quarter = ?
        ORDER BY rank_in_quarter ASC
        LIMIT ${top}`, [year, quarter]);
        res.json({
            success: true,
            year,
            quarter,
            ranks: rows.map(r => ({
                spec_id: r.spec_id,
                spec_name: r.spec_name,
                wholesale_qty: r.wholesale_qty,
                rank: r.rank_in_quarter,
            })),
        });
    }
    catch (err) {
        const code = err.code;
        if (code === 'ER_NO_SUCH_TABLE') {
            res.json({ success: true, year: null, quarter: null, ranks: [] });
            return;
        }
        console.error('Query wholesale-rank error:', err);
        res.status(500).json({ success: false, error: '查询失败' });
    }
});
exports.default = router;
