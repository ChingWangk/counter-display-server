import { Router, Request, Response } from 'express';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import pool from '../db';
import { categoryMap } from '../services/categoryCatalog';

/**
 * 陈列看板(后台管理平台 /admin/board.html)专用接口,挂在 /api/admin/board,经 adminAuth 令牌校验。
 *
 * 看板 = 小程序出图 + 库存编辑:页面调 /api/generate 拿每个柜台的逐格清单(manifest)画出可拖拽的柜台,
 * 拖入/拖出烟包时调本路由增删该客户 cust_inventory 中的经营品规,再重新出图。
 *
 *  GET    /:cid                 客户信息 + 柜台档案 + 经营品规(每个规格取最新快照)
 *  POST   /:cid/specs           { spec_id, stock_qty? } 新增经营品规(写一条今日快照)
 *  DELETE /:cid/specs/:specId   删除该规格的全部快照行(删前整行存入 board_ops_log,可撤销)
 *  PUT    /:cid/counters        { counters:[{counter_id?,type,length,levels}] } 整体替换柜台档案(顺序即 sort_order)
 *  POST   /:cid/undo            撤销该客户最近一次看板操作(增删品规 / 柜台编辑)
 *
 * 每次操作都记入 board_ops_log(懒建表):既是改动前的备份,也是操作审计,撤销据此恢复。
 * 柜台编辑记的是改动前的整份柜台档案(op='counters'),撤销即整份写回。
 */

const router = Router();

/** 看板新增规格的默认库存:1 条 = 10 包;可供天数无动销数据,填 15(< 30,不被判为滞销)。 */
const DEFAULT_STOCK_QTY = 10;
const DEFAULT_STOCK_DAYS = 15;

interface InvRow extends RowDataPacket {
  spec_id: string;
  stock_qty: number;
  stock_days: number;
  snapshot_date: string | Date;
}

interface LogRow extends RowDataPacket {
  id: number;
  op: 'add' | 'remove' | 'counters';
  spec_id: string;
  rows_json: string;
}

let logTableReady = false;
async function ensureLogTable(): Promise<void> {
  if (logTableReady) return;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS board_ops_log (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      customer_id VARCHAR(64) NOT NULL,
      op          VARCHAR(16) NOT NULL,
      spec_id     VARCHAR(32) NOT NULL,
      rows_json   MEDIUMTEXT NOT NULL,
      undone      TINYINT(1) NOT NULL DEFAULT 0,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cust (customer_id, undone, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // 早期版本 op 为 ENUM('add','remove'),放宽为 VARCHAR 以记柜台编辑(幂等)
  await pool.execute(`ALTER TABLE board_ops_log MODIFY op VARCHAR(16) NOT NULL`);
  logTableReady = true;
}

const dateStr = (d: string | Date): string =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

const today = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const validCid = (cid: string): boolean => /^[0-9A-Za-z_-]{1,64}$/.test(cid);

router.get('/:cid', async (req: Request, res: Response) => {
  const cid = req.params.cid;
  if (!validCid(cid)) { res.status(400).json({ success: false, error: '客户代码格式不对' }); return; }
  try {
    const [info] = await pool.execute<RowDataPacket[]>(
      'SELECT customer_id, customer_name, joined_at, has_pos FROM cust_info WHERE customer_id = ?', [cid]);
    const [counters] = await pool.execute<RowDataPacket[]>(
      'SELECT counter_id, type, length, levels, sort_order FROM cust_counters WHERE customer_id = ? ORDER BY sort_order', [cid]);
    const [inv] = await pool.execute<InvRow[]>(
      `SELECT t.spec_id, t.stock_qty, t.stock_days, t.snapshot_date
         FROM cust_inventory t
         JOIN (SELECT spec_id, MAX(snapshot_date) AS d FROM cust_inventory WHERE customer_id = ? GROUP BY spec_id) m
           ON t.spec_id = m.spec_id AND t.snapshot_date = m.d
        WHERE t.customer_id = ?`, [cid, cid]);
    res.json({
      success: true,
      customer: info[0] ?? null,
      counters,
      inventory: inv.map(r => ({
        spec_id: r.spec_id,
        name: categoryMap.get(r.spec_id)?.name ?? r.spec_id,
        inCatalog: categoryMap.has(r.spec_id),
        stock_qty: Number(r.stock_qty),
        stock_days: Number(r.stock_days),
        snapshot_date: dateStr(r.snapshot_date),
      })),
    });
  } catch (err) {
    console.error('[adminBoard] load error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : '读取失败' });
  }
});

router.post('/:cid/specs', async (req: Request, res: Response) => {
  const cid = req.params.cid;
  const specId = String((req.body || {}).spec_id || '').trim();
  const qty = Number((req.body || {}).stock_qty);
  if (!validCid(cid) || !categoryMap.has(specId)) {
    res.status(400).json({ success: false, error: '客户代码或规格不存在' });
    return;
  }
  const stockQty = Number.isFinite(qty) && qty > 0 ? Math.round(qty) : DEFAULT_STOCK_QTY;
  try {
    await ensureLogTable();
    const [cur] = await pool.execute<InvRow[]>(
      `SELECT stock_qty FROM cust_inventory WHERE customer_id = ? AND spec_id = ?
        ORDER BY snapshot_date DESC LIMIT 1`, [cid, specId]);
    if (cur.length > 0 && Number(cur[0].stock_qty) > 0) {
      res.json({ success: true, unchanged: true });  // 已在经营,无需重复添加
      return;
    }
    const row = { customer_id: cid, spec_id: specId, stock_qty: stockQty, stock_days: DEFAULT_STOCK_DAYS, snapshot_date: today() };
    // 同日已有快照(如当天删后又加)→ 覆盖为在售
    await pool.execute(
      `INSERT INTO cust_inventory (customer_id, spec_id, stock_qty, stock_days, snapshot_date)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE stock_qty = VALUES(stock_qty), stock_days = VALUES(stock_days)`,
      [row.customer_id, row.spec_id, row.stock_qty, row.stock_days, row.snapshot_date]);
    await pool.execute(
      'INSERT INTO board_ops_log (customer_id, op, spec_id, rows_json) VALUES (?, ?, ?, ?)',
      [cid, 'add', specId, JSON.stringify([row])]);
    res.json({ success: true });
  } catch (err) {
    console.error('[adminBoard] add error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : '添加失败' });
  }
});

router.delete('/:cid/specs/:specId', async (req: Request, res: Response) => {
  const { cid, specId } = req.params;
  if (!validCid(cid) || !/^\w{1,32}$/.test(specId)) {
    res.status(400).json({ success: false, error: '参数不对' });
    return;
  }
  const conn = await pool.getConnection();
  try {
    await ensureLogTable();
    await conn.beginTransaction();
    const [rows] = await conn.execute<InvRow[]>(
      'SELECT spec_id, stock_qty, stock_days, snapshot_date FROM cust_inventory WHERE customer_id = ? AND spec_id = ?',
      [cid, specId]);
    if (rows.length === 0) { await conn.rollback(); res.json({ success: true, unchanged: true }); return; }
    // 删前先把整行存进日志(= 备份),撤销时原样写回
    const backup = rows.map(r => ({
      customer_id: cid, spec_id: r.spec_id, stock_qty: Number(r.stock_qty),
      stock_days: Number(r.stock_days), snapshot_date: dateStr(r.snapshot_date),
    }));
    await conn.execute(
      'INSERT INTO board_ops_log (customer_id, op, spec_id, rows_json) VALUES (?, ?, ?, ?)',
      [cid, 'remove', specId, JSON.stringify(backup)]);
    await conn.execute('DELETE FROM cust_inventory WHERE customer_id = ? AND spec_id = ?', [cid, specId]);
    await conn.commit();
    res.json({ success: true, removedRows: rows.length });
  } catch (err) {
    await conn.rollback();
    console.error('[adminBoard] remove error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : '删除失败' });
  } finally {
    conn.release();
  }
});

interface CounterRow extends RowDataPacket {
  counter_id: string;
  type: string;
  length: number;
  levels: number;
  sort_order: number;
}

interface CounterInput { counter_id?: string; type: string; length: number; levels: number }

const COUNTER_PREFIX: Record<string, string> = { front: 'QG', hanging: 'DG', back: 'BG' };

/** 写入一份柜台档案(先删后插,顺序即 sort_order);调用方负责事务。 */
async function writeCounters(
  conn: import('mysql2/promise').PoolConnection,
  cid: string,
  list: { counter_id: string; type: string; length: number; levels: number }[],
): Promise<void> {
  await conn.execute('DELETE FROM cust_counters WHERE customer_id = ?', [cid]);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    await conn.execute(
      'INSERT INTO cust_counters (customer_id, counter_id, type, length, levels, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [cid, c.counter_id, c.type, c.length, c.levels, i + 1]);
  }
}

router.put('/:cid/counters', async (req: Request, res: Response) => {
  const cid = req.params.cid;
  const input = (req.body || {}).counters as CounterInput[] | undefined;
  if (!validCid(cid) || !Array.isArray(input)) {
    res.status(400).json({ success: false, error: '参数不对' });
    return;
  }
  for (const c of input) {
    const len = Number(c.length), lv = Number(c.levels);
    if (!COUNTER_PREFIX[c.type] || !Number.isInteger(len) || len < 6 || len > 1000 || !Number.isInteger(lv) || lv < 1 || lv > 20) {
      res.status(400).json({ success: false, error: '柜台类型须为前柜/吊柜/背柜,长度 6–1000 cm、层数 1–20 的整数' });
      return;
    }
  }
  const conn = await pool.getConnection();
  try {
    await ensureLogTable();
    await conn.beginTransaction();
    const [before] = await conn.execute<CounterRow[]>(
      'SELECT counter_id, type, length, levels, sort_order FROM cust_counters WHERE customer_id = ? ORDER BY sort_order FOR UPDATE',
      [cid]);
    // 保留原 counter_id;新增的按类型前缀续号(如 116320143QG004),不与已有/本次的 id 撞号
    const used = new Set<string>([...before.map(r => r.counter_id), ...input.map(c => c.counter_id || '')]);
    const nextId = (type: string): string => {
      for (let n = 1; ; n++) {
        const id = `${cid}${COUNTER_PREFIX[type]}${String(n).padStart(3, '0')}`;
        if (!used.has(id)) { used.add(id); return id; }
      }
    };
    const keepIds = new Set(before.map(r => r.counter_id));
    const list = input.map(c => ({
      counter_id: c.counter_id && keepIds.has(c.counter_id) ? c.counter_id : nextId(c.type),
      type: c.type, length: Number(c.length), levels: Number(c.levels),
    }));
    await conn.execute(
      'INSERT INTO board_ops_log (customer_id, op, spec_id, rows_json) VALUES (?, ?, ?, ?)',
      [cid, 'counters', '', JSON.stringify(before.map(r => ({
        counter_id: r.counter_id, type: r.type, length: Number(r.length), levels: Number(r.levels),
      })))]);
    await writeCounters(conn, cid, list);
    await conn.commit();
    res.json({ success: true, counters: list });
  } catch (err) {
    await conn.rollback();
    console.error('[adminBoard] counters error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : '保存柜台失败' });
  } finally {
    conn.release();
  }
});

router.post('/:cid/undo', async (req: Request, res: Response) => {
  const cid = req.params.cid;
  if (!validCid(cid)) { res.status(400).json({ success: false, error: '客户代码格式不对' }); return; }
  const conn = await pool.getConnection();
  try {
    await ensureLogTable();
    await conn.beginTransaction();
    const [logs] = await conn.execute<LogRow[]>(
      'SELECT id, op, spec_id, rows_json FROM board_ops_log WHERE customer_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1 FOR UPDATE',
      [cid]);
    if (logs.length === 0) { await conn.rollback(); res.json({ success: true, nothing: true }); return; }
    const log = logs[0];
    if (log.op === 'counters') {
      await writeCounters(conn, cid, JSON.parse(log.rows_json));
      await conn.execute('UPDATE board_ops_log SET undone = 1 WHERE id = ?', [log.id]);
      await conn.commit();
      res.json({ success: true, op: 'counters', spec_id: '', name: '柜台编辑' });
      return;
    }
    const rows = JSON.parse(log.rows_json) as {
      customer_id: string; spec_id: string; stock_qty: number; stock_days: number; snapshot_date: string;
    }[];
    if (log.op === 'add') {
      for (const r of rows) {
        await conn.execute(
          'DELETE FROM cust_inventory WHERE customer_id = ? AND spec_id = ? AND snapshot_date = ?',
          [cid, r.spec_id, r.snapshot_date]);
      }
    } else {
      for (const r of rows) {
        await conn.execute(
          `INSERT INTO cust_inventory (customer_id, spec_id, stock_qty, stock_days, snapshot_date)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE stock_qty = VALUES(stock_qty), stock_days = VALUES(stock_days)`,
          [cid, r.spec_id, r.stock_qty, r.stock_days, r.snapshot_date]);
      }
    }
    const [upd] = await conn.execute<ResultSetHeader>('UPDATE board_ops_log SET undone = 1 WHERE id = ?', [log.id]);
    await conn.commit();
    res.json({ success: true, op: log.op, spec_id: log.spec_id, name: categoryMap.get(log.spec_id)?.name ?? log.spec_id, affected: upd.affectedRows });
  } catch (err) {
    await conn.rollback();
    console.error('[adminBoard] undo error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : '撤销失败' });
  } finally {
    conn.release();
  }
});

export default router;
