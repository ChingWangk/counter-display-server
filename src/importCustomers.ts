/**
 * Excel 批量导入客户品规数据到 customer_specs 表
 *
 * Excel 格式：
 *   第一行为表头（自动跳过）
 *   A 列 = 客户编号（customer_id）
 *   B 列起 = 每格一个品规 ID
 *
 * 用法：
 *   npx ts-node src/importCustomers.ts <excel文件路径>
 *   npm run import-customers -- <excel文件路径>
 */
import * as XLSX from 'xlsx';
import pool from './db';
import { ResultSetHeader } from 'mysql2';

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('用法: npx ts-node src/importCustomers.ts <excel文件路径>');
    process.exit(1);
  }

  console.log(`读取文件: ${filePath}`);
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // 转为二维数组（每行一个数组），包含表头
  const rows: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: undefined,
  });

  if (rows.length < 2) {
    console.error('Excel 中没有数据行（第一行为表头，至少需要两行）');
    process.exit(1);
  }

  // 跳过表头
  const dataRows = rows.slice(1);

  let success = 0;
  let skipped = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowNum = i + 2; // Excel 行号（1-based，含表头）

    // A 列：客户编号
    const customerId = String(row[0] ?? '').trim();
    if (!customerId) {
      console.warn(`第 ${rowNum} 行：客户编号为空，跳过`);
      skipped++;
      continue;
    }

    // B 列起：收集所有非空品规 ID
    const specIds: string[] = [];
    for (let col = 1; col < row.length; col++) {
      const val = String(row[col] ?? '').trim();
      if (val) specIds.push(val);
    }

    const specCount = specIds.length;
    const specDetail = specIds.length > 0 ? specIds.join(',') : null;

    try {
      await pool.execute<ResultSetHeader>(
        `INSERT INTO customer_specs (customer_id, spec_count, spec_detail)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE spec_count = VALUES(spec_count), spec_detail = VALUES(spec_detail)`,
        [customerId, specCount, specDetail]
      );
      success++;
    } catch (err) {
      console.error(`第 ${rowNum} 行 [${customerId}] 写入失败:`, err);
      skipped++;
    }
  }

  console.log(`\n导入完成: 成功 ${success} 条, 跳过 ${skipped} 条`);
  await pool.end();
}

main().catch(err => {
  console.error('导入失败:', err);
  process.exit(1);
});
