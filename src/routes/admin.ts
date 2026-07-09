import express, { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import pool from '../db';
import { ADMIN_TABLES, getAdminTable, ImportMode } from '../services/adminTables';

/**
 * 通用后台数据接口（全程经 adminAuth 鉴权，见 app.ts 挂载处）。
 *   GET  /api/admin/tables                 表清单 + 行数 + 新鲜度（驱动看板/维护台）
 *   GET  /api/admin/tables/:key/rows       分页 / 搜索 / 排序（剔除敏感列）
 *   GET  /api/admin/tables/:key/export     全量导出 CSV（剔除敏感列）
 *   POST /api/admin/tables/:key/import     Excel/CSV 导入（dryRun 预览 / upsert / replace / append）
 *
 * 安全：表名/列名/排序全部来自「注册表 + information_schema 自省」的受信白名单，
 *       用户输入只经 `?` 占位传值；敏感列（如明文密码）全链路剔除。
 */

const router = Router();

/** 反引号包裹标识符（标识符来自受信白名单，仍防御性去掉内嵌反引号）。 */
const q = (id: string): string => '`' + String(id).replace(/`/g, '') + '`';

function errCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
/** 本地时间戳 yyyymmdd_HHMMSS（用于备份/导出文件名）。 */
function stamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ---------------- 列自省（5 分钟缓存） ----------------
interface ColMeta {
  name: string;
  dataType: string;
  isString: boolean;
  isNumeric: boolean;
  isAuto: boolean;
  nullable: boolean;
}
const STR_TYPES = new Set(['char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext', 'enum', 'set']);
const NUM_TYPES = new Set(['int', 'tinyint', 'smallint', 'mediumint', 'bigint', 'decimal', 'float', 'double', 'year']);
const colCache = new Map<string, { at: number; cols: ColMeta[] }>();
const COL_TTL_MS = 5 * 60 * 1000;

async function getColumns(table: string): Promise<ColMeta[]> {
  const cached = colCache.get(table);
  if (cached && Date.now() - cached.at < COL_TTL_MS) return cached.cols;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS dt, EXTRA AS extra, IS_NULLABLE AS nullable
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [table],
  );
  const cols: ColMeta[] = rows.map(r => {
    const rec = r as { name: string; dt: string; extra: string | null; nullable: string };
    const dt = String(rec.dt).toLowerCase();
    return {
      name: String(rec.name),
      dataType: dt,
      isString: STR_TYPES.has(dt),
      isNumeric: NUM_TYPES.has(dt),
      isAuto: String(rec.extra || '').toLowerCase().includes('auto_increment'),
      nullable: String(rec.nullable).toUpperCase() === 'YES',
    };
  });
  colCache.set(table, { at: Date.now(), cols });
  return cols;
}

// ---------------- CSV ----------------
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const head = headers.map(csvCell).join(',');
  const body = rows.map(r => headers.map(h => csvCell(r[h])).join(',')).join('\r\n');
  return body ? head + '\r\n' + body : head;
}

/** 破坏性导入前把当前整表快照落成 CSV（纯 Node fs，不 shell out）。返回相对路径。 */
async function backupTable(table: string): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM ${q(table)}`);
  const list = rows as Record<string, unknown>[];
  const headers = list.length ? Object.keys(list[0]) : [];
  const csv = '﻿' + toCsv(headers, list);
  const dir = path.join(__dirname, '../../backups');  // dist/routes → server/backups
  fs.mkdirSync(dir, { recursive: true });
  const name = `${table}_${stamp()}.csv`;
  fs.writeFileSync(path.join(dir, name), csv, 'utf8');
  return `backups/${name}`;
}

// ================================================================
// GET /tables — 清单 + 行数 + 新鲜度
// ================================================================
router.get('/tables', async (_req: Request, res: Response) => {
  const out = [];
  for (const t of ADMIN_TABLES) {
    let exists = true;
    let rowCount = 0;
    let latest: string | null = null;
    try {
      const [cr] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${q(t.table)}`);
      rowCount = Number((cr[0] as { n: number }).n) || 0;
      if (t.freshness) {
        const [fr] = await pool.query<RowDataPacket[]>(
          `SELECT ${t.freshness.select} AS latest FROM ${q(t.table)} ORDER BY ${t.freshness.order} DESC LIMIT 1`,
        );
        latest = fr.length ? String((fr[0] as { latest: unknown }).latest ?? '') : null;
      }
    } catch (e) {
      exists = false;
      if (errCode(e) !== 'ER_NO_SUCH_TABLE') console.warn(`[admin] tables meta ${t.table}:`, errCode(e));
    }
    out.push({
      key: t.key, table: t.table, label: t.label, category: t.category, cadence: t.cadence,
      managed: t.managed, importable: t.importable, importMode: t.importMode, keyColumns: t.keyColumns,
      note: t.note || null, exists, rowCount,
      freshnessUnit: t.freshness ? t.freshness.unit : null, latest,
    });
  }
  res.json({ success: true, tables: out });
});

// ================================================================
// GET /tables/:key/rows — 分页 / 搜索 / 排序
// ================================================================
router.get('/tables/:key/rows', async (req: Request, res: Response) => {
  const def = getAdminTable(req.params.key);
  if (!def) { res.status(400).json({ success: false, error: '未登记的表' }); return; }
  try {
    const cols = await getColumns(def.table);
    if (cols.length === 0) { res.json({ success: true, columns: [], rows: [], total: 0, page: 1, pageSize: 0, tableMissing: true }); return; }

    const sensitive = new Set(def.sensitiveColumns || []);
    const visible = cols.filter(c => !sensitive.has(c.name));
    const visNames = new Set(visible.map(c => c.name));

    // 搜索（默认所有字符串列，或注册表 searchable ∩ 可见列）
    const search = String(req.query.search || '').trim();
    const searchCols = (def.searchable && def.searchable.length
      ? def.searchable.filter(n => visNames.has(n))
      : visible.filter(c => c.isString).map(c => c.name));
    const params: unknown[] = [];
    let whereSql = '';
    if (search && searchCols.length) {
      whereSql = ' WHERE (' + searchCols.map(n => `${q(n)} LIKE ?`).join(' OR ') + ')';
      for (let i = 0; i < searchCols.length; i++) params.push(`%${search}%`);
    }

    // 排序（白名单校验）
    let orderBy = String(req.query.orderBy || '').trim();
    if (!visNames.has(orderBy)) {
      orderBy = (def.defaultOrderBy && visNames.has(def.defaultOrderBy))
        ? def.defaultOrderBy
        : (def.keyColumns.find(k => visNames.has(k)) || visible[0].name);
    }
    const dir = String(req.query.dir || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    // 分页（整数夹紧，可安全内联）
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize || '20'), 10) || 20));
    const offset = (page - 1) * pageSize;

    const [cr] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${q(def.table)}${whereSql}`, params);
    const total = Number((cr[0] as { n: number }).n) || 0;

    const selectList = visible.map(c => q(c.name)).join(', ');
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${selectList} FROM ${q(def.table)}${whereSql} ORDER BY ${q(orderBy)} ${dir} LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );

    res.json({
      success: true,
      columns: visible.map(c => ({ name: c.name, type: c.dataType })),
      rows, total, page, pageSize, orderBy, dir,
    });
  } catch (e) {
    if (errCode(e) === 'ER_NO_SUCH_TABLE') {
      res.json({ success: true, columns: [], rows: [], total: 0, page: 1, pageSize: 0, tableMissing: true });
      return;
    }
    console.error('admin rows error:', e);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

// ================================================================
// GET /tables/:key/export — 全量 CSV
// ================================================================
router.get('/tables/:key/export', async (req: Request, res: Response) => {
  const def = getAdminTable(req.params.key);
  if (!def) { res.status(400).json({ success: false, error: '未登记的表' }); return; }
  try {
    const cols = await getColumns(def.table);
    const sensitive = new Set(def.sensitiveColumns || []);
    const visible = cols.filter(c => !sensitive.has(c.name));
    const selectList = visible.map(c => q(c.name)).join(', ');
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT ${selectList} FROM ${q(def.table)}`);
    const csv = '﻿' + toCsv(visible.map(c => c.name), rows as Record<string, unknown>[]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${def.key}_${stamp()}.csv"`);
    res.send(csv);
  } catch (e) {
    if (errCode(e) === 'ER_NO_SUCH_TABLE') { res.status(404).json({ success: false, error: '表不存在' }); return; }
    console.error('admin export error:', e);
    res.status(500).json({ success: false, error: '导出失败' });
  }
});

// ================================================================
// POST /tables/:key/import — Excel/CSV 导入
// ================================================================
router.post('/tables/:key/import', express.raw({ type: () => true, limit: '25mb' }), async (req: Request, res: Response) => {
  const def = getAdminTable(req.params.key);
  if (!def) { res.status(400).json({ success: false, error: '未登记的表' }); return; }
  if (!def.importable || def.importMode === 'readonly') {
    res.status(403).json({ success: false, error: '该表不允许导入（挖掘/只读）' });
    return;
  }

  const dryRun = String(req.query.dryRun || '') === '1';
  const confirm = String(req.query.confirm || '') === '1';
  let mode = String(req.query.mode || '') as ImportMode;
  if (!['upsert', 'replace', 'append'].includes(mode)) mode = def.importMode;

  const buf = req.body as Buffer;
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
    res.status(400).json({ success: false, error: '未收到文件内容' });
    return;
  }

  try {
    // ---- 解析 ----
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) { res.status(400).json({ success: false, error: '空文件或无工作表' }); return; }
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null, raw: false });

    // ---- 列映射（表头 → 真实列，忽略大小写/空白；剔除自增 + 敏感列）----
    const cols = await getColumns(def.table);
    const sensitive = new Set(def.sensitiveColumns || []);
    const targetCols = cols.filter(c => !c.isAuto && !sensitive.has(c.name));
    const norm = (s: string) => s.trim().toLowerCase();
    const headerKeys = raw.length ? Object.keys(raw[0]) : [];
    const headerMap = new Map<string, string>();  // realCol -> headerKey
    for (const c of targetCols) {
      const hit = headerKeys.find(h => norm(h) === norm(c.name));
      if (hit) headerMap.set(c.name, hit);
    }
    const mappedCols = targetCols.filter(c => headerMap.has(c.name)).map(c => c.name);
    if (mappedCols.length === 0) {
      res.status(400).json({ success: false, error: `表头无法匹配任何列。期望列：${targetCols.map(c => c.name).join(', ')}` });
      return;
    }
    const colMeta = new Map(targetCols.map(c => [c.name, c]));

    // ---- 构行 + 校验 ----
    const errors: { row: number; msg: string }[] = [];
    const values: unknown[][] = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      const anyVal = mappedCols.some(c => {
        const v = r[headerMap.get(c) as string];
        return v !== null && v !== undefined && String(v).trim() !== '';
      });
      if (!anyVal) continue;  // 跳过全空行

      const rowVals: unknown[] = [];
      let bad = false;
      for (const c of mappedCols) {
        const meta = colMeta.get(c) as ColMeta;
        const v = r[headerMap.get(c) as string];
        if (v === null || v === undefined || String(v).trim() === '') { rowVals.push(null); continue; }
        if (meta.isNumeric) {
          const n = Number(String(v).replace(/,/g, ''));
          if (!Number.isFinite(n)) { errors.push({ row: i + 2, msg: `列 ${c} 非数值：${v}` }); bad = true; break; }
          rowVals.push(n);
        } else {
          rowVals.push(String(v).trim());
        }
      }
      if (bad) continue;
      // 主键列非空
      let keyMissing = false;
      for (const k of def.keyColumns) {
        const idx = mappedCols.indexOf(k);
        if (idx >= 0 && rowVals[idx] === null) { errors.push({ row: i + 2, msg: `主键列 ${k} 不能为空` }); keyMissing = true; break; }
      }
      if (keyMissing) continue;
      values.push(rowVals);
    }

    const preview = {
      table: def.table, mode, mappedColumns: mappedCols,
      totalRows: raw.length, validRows: values.length, errorCount: errors.length,
      sample: values.slice(0, 8).map(v => Object.fromEntries(mappedCols.map((c, idx) => [c, v[idx]]))),
      errors: errors.slice(0, 20),
    };

    if (dryRun) { res.json({ success: true, dryRun: true, preview }); return; }
    if (values.length === 0) { res.status(400).json({ success: false, error: '无有效数据行', preview }); return; }
    if (mode === 'replace' && !confirm) { res.status(400).json({ success: false, error: '整表替换需二次确认 (confirm=1)', preview }); return; }
    if (mode === 'replace' && sensitive.size > 0) { res.status(400).json({ success: false, error: '含敏感列的表禁止整表替换，请用增量合并' }); return; }

    // ---- 写库 ----
    const colList = mappedCols.map(q).join(', ');
    const setCols = mappedCols.filter(c => !def.keyColumns.includes(c));
    const odkuTail = ' ON DUPLICATE KEY UPDATE ' +
      (setCols.length ? setCols : mappedCols).map(c => `${q(c)}=VALUES(${q(c)})`).join(', ');
    const CHUNK = 500;
    let affected = 0;
    let backupFile: string | null = null;

    // 批量插入（mysql2 `VALUES ?` 展开 array-of-arrays）
    type Queryable = { query: (sql: string, params: unknown) => Promise<[unknown, unknown]> };
    async function runBatches(conn: Queryable, tail: string): Promise<void> {
      for (let i = 0; i < values.length; i += CHUNK) {
        const chunk = values.slice(i, i + CHUNK);
        const [r] = await conn.query(`INSERT INTO ${q(def!.table)} (${colList}) VALUES ?${tail}`, [chunk]);
        affected += (r as ResultSetHeader).affectedRows || 0;
      }
    }

    if (mode === 'replace') {
      backupFile = await backupTable(def.table);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query(`DELETE FROM ${q(def.table)}`);
        await runBatches(conn as unknown as Queryable, '');
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    } else if (mode === 'upsert') {
      await runBatches(pool as unknown as Queryable, odkuTail);
    } else {  // append
      await runBatches(pool as unknown as Queryable, '');
    }

    res.json({ success: true, mode, written: values.length, affectedRows: affected, backupFile, preview });
  } catch (e) {
    console.error('admin import error:', e);
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : '导入失败' });
  }
});

export default router;
