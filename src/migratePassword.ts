import pool from './db';
import { RowDataPacket } from 'mysql2';

/**
 * 登录密码功能迁移（幂等、非破坏性，可重复执行）：
 *  1. 确保 cust_info 表存在（含 login_password 列）
 *  2. 存量 cust_info 若缺 login_password 列 → ALTER 新增，DEFAULT '111'（既有行自动获得 '111'）
 *  3. 从 cust_inventory / cust_counters 回填缺失的客户行（INSERT IGNORE，密码 '111'）
 *     —— 保证所有"有数据的客户"都能用初始密码登录
 *  4. 把 login_password 为 NULL/空 的行补成 '111'
 *
 * 安全:UPDATE 只作用于 NULL/空 的密码，绝不覆盖客户已改的密码。运行前建议先备份 cust_info。
 * 运行:  cd server && npx ts-node src/migratePassword.ts   （或 build 后 node dist/migratePassword.js）
 */
async function migratePassword() {
  const conn = await pool.getConnection();
  try {
    // 1. 表不存在则建（已存在则跳过，不影响现有结构）
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS cust_info (
        customer_id    VARCHAR(64) NOT NULL PRIMARY KEY,
        joined_at      DATE NULL,
        has_pos        TINYINT(1) NOT NULL DEFAULT 0,
        login_password VARCHAR(64) NOT NULL DEFAULT '111'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 2. 存量表缺列 → 新增（DEFAULT '111' 使既有行立即获得初始密码）
    const [cols] = await conn.execute<RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cust_info' AND COLUMN_NAME = 'login_password'`
    );
    if (cols.length === 0) {
      await conn.execute(
        `ALTER TABLE cust_info ADD COLUMN login_password VARCHAR(64) NOT NULL DEFAULT '111'`
      );
      console.log("✅ cust_info 新增 login_password 列（默认 '111'）");
    } else {
      console.log('ℹ️  login_password 列已存在，跳过 ALTER');
    }

    // 3. 回填缺失的客户行（有库存/柜台数据但 cust_info 无行的客户），密码 '111'
    for (const src of ['cust_inventory', 'cust_counters']) {
      try {
        const [r] = await conn.execute(
          `INSERT IGNORE INTO cust_info (customer_id, login_password)
           SELECT DISTINCT customer_id, '111' FROM ${src}`
        );
        const affected = (r as { affectedRows?: number }).affectedRows ?? 0;
        console.log(`✅ 从 ${src} 回填客户行:${affected} 条`);
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'ER_NO_SUCH_TABLE') {
          console.log(`ℹ️  ${src} 表不存在，跳过回填`);
        } else {
          throw err;
        }
      }
    }

    // 4. 补齐 NULL/空 密码为 '111'（不覆盖已设置的密码）
    const [upd] = await conn.execute(
      `UPDATE cust_info SET login_password = '111' WHERE login_password IS NULL OR login_password = ''`
    );
    console.log(`✅ 初始密码补齐:${(upd as { affectedRows?: number }).affectedRows ?? 0} 条置为 '111'`);

    console.log('🎉 登录密码迁移完成');
  } finally {
    conn.release();
    await pool.end();
  }
}

migratePassword().catch(err => {
  console.error('❌ 密码迁移失败:', err);
  process.exit(1);
});
