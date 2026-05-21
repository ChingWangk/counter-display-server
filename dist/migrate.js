"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = __importDefault(require("./db"));
async function migrate() {
    const conn = await db_1.default.getConnection();
    try {
        await conn.execute(`
      CREATE TABLE IF NOT EXISTS customer_specs (
        customer_id VARCHAR(64) NOT NULL PRIMARY KEY,
        spec_count  INT NOT NULL DEFAULT 0,
        spec_detail TEXT,
        updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
        console.log('✅ customer_specs 表创建成功');
    }
    finally {
        conn.release();
        await db_1.default.end();
    }
}
migrate().catch(err => {
    console.error('❌ 建表失败:', err);
    process.exit(1);
});
