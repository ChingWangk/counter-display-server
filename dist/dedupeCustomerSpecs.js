"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 一次性清理 customer_specs 表中已有数据的重复品规
 *
 * 处理逻辑：
 *   - 拆分 spec_detail（逗号分隔的品规 ID 列表）
 *   - 去重（保留首次出现顺序）
 *   - 重新计算 spec_count
 *   - 仅当确实存在重复时才 UPDATE，避免无谓写入触发 updated_at 变更
 *
 * 用法：
 *   npm run dedupe-customers
 */
const db_1 = __importDefault(require("./db"));
async function dedupe() {
    const conn = await db_1.default.getConnection();
    try {
        const [rows] = await conn.execute('SELECT customer_id, spec_count, spec_detail FROM customer_specs');
        console.log(`扫描 ${rows.length} 个客户...\n`);
        let affected = 0;
        let totalDupRemoved = 0;
        for (const row of rows) {
            if (!row.spec_detail)
                continue;
            const ids = row.spec_detail.split(',').map(s => s.trim()).filter(s => s);
            const seen = new Set();
            const deduped = [];
            const duplicates = [];
            for (const id of ids) {
                if (seen.has(id)) {
                    duplicates.push(id);
                }
                else {
                    seen.add(id);
                    deduped.push(id);
                }
            }
            if (duplicates.length === 0)
                continue;
            const newDetail = deduped.length > 0 ? deduped.join(',') : null;
            const newCount = deduped.length;
            await conn.execute('UPDATE customer_specs SET spec_count = ?, spec_detail = ? WHERE customer_id = ?', [newCount, newDetail, row.customer_id]);
            affected++;
            totalDupRemoved += duplicates.length;
            console.log(`[${row.customer_id}] 去除 ${duplicates.length} 个重复 (${row.spec_count} → ${newCount}): ${duplicates.join(',')}`);
        }
        console.log(`\n✅ 清理完成: ${affected} 个客户被更新, 共去除 ${totalDupRemoved} 个重复品规`);
    }
    finally {
        conn.release();
        await db_1.default.end();
    }
}
dedupe().catch(err => {
    console.error('❌ 去重失败:', err);
    process.exit(1);
});
