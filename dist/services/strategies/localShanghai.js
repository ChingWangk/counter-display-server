"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchLatestLocalBrandGrowth = fetchLatestLocalBrandGrowth;
const db_1 = __importDefault(require("../../db"));
/** 拉取 ref_local_brand_growth 最新季度的 spec_id → yoy_rate 映射。 */
async function fetchLatestLocalBrandGrowth() {
    const map = new Map();
    try {
        const [latest] = await db_1.default.execute(`SELECT year, quarter FROM ref_local_brand_growth
        ORDER BY year DESC, quarter DESC LIMIT 1`);
        if (latest.length === 0)
            return map;
        const { year, quarter } = latest[0];
        const [rows] = await db_1.default.execute(`SELECT spec_id, yoy_rate FROM ref_local_brand_growth
        WHERE year = ? AND quarter = ?`, [year, quarter]);
        for (const r of rows) {
            if (r.yoy_rate === null)
                continue;
            const n = Number(r.yoy_rate);
            if (!isNaN(n))
                map.set(r.spec_id, n);
        }
    }
    catch (err) {
        const code = err.code;
        if (code === 'ER_NO_SUCH_TABLE')
            return map;
        console.error('fetchLatestLocalBrandGrowth error:', err);
    }
    return map;
}
