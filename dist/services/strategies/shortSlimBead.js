"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchLatestMarketCoverage = fetchLatestMarketCoverage;
exports.fetchLatestOrderFillRate = fetchLatestOrderFillRate;
const db_1 = __importDefault(require("../../db"));
async function fetchLatestRateMap(table, rateColumn) {
    const map = new Map();
    try {
        // 取最新 snapshot_month + 该月所有 (spec_id, rate)。一次 SQL,简单。
        const [rows] = await db_1.default.execute(`SELECT spec_id, ${rateColumn} AS rate FROM ${table}
        WHERE snapshot_month = (SELECT MAX(snapshot_month) FROM ${table})`);
        for (const r of rows) {
            if (r.rate === null)
                continue;
            const n = Number(r.rate);
            if (!isNaN(n))
                map.set(r.spec_id, n);
        }
    }
    catch (err) {
        const code = err.code;
        if (code === 'ER_NO_SUCH_TABLE')
            return map;
        console.error(`fetchLatestRateMap(${table}) error:`, err);
    }
    return map;
}
/** ref_market_coverage 最新月份的 spec_id → coverage_rate 映射(0~1 区间)。 */
function fetchLatestMarketCoverage() {
    return fetchLatestRateMap('ref_market_coverage', 'coverage_rate');
}
/** ref_order_fill_rate 最新月份的 spec_id → fill_rate 映射(0~1 区间)。 */
function fetchLatestOrderFillRate() {
    return fetchLatestRateMap('ref_order_fill_rate', 'fill_rate');
}
