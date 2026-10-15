import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import pool from '../db';
import { FESTIVAL_META, FestivalId } from './strategies/types';

/**
 * 节日专区 · 客户投稿主题陈列图 → 后台审核 → 公共素材。
 *
 *  流程:客户在 zone-select 节日弹窗上传(按当前所选节日打标) → status=pending(本人可先用) →
 *        后台管理平台「主题图审核」通过 → status=approved,出现在所有客户该节日的「大家的主题图」里;
 *        驳回 → status=rejected(附原因),本人可见原因、不可再用。
 *  存放:图片 `/www/wwwroot/47.103.65.4/images/user-festival/{customer_id}/{时间戳}_{随机}.{png|jpg}`(Nginx 静态直出);
 *        审核状态落表 festival_submissions(首次使用时自动 CREATE TABLE IF NOT EXISTS,不动其他表)。
 *  校验红线:customer_id 只允许字母数字;类型按魔数判定;generate 只认"已通过"或"本人审核中"的投稿 URL,
 *            杜绝伪造 URL / 引用他人未审核或被驳回的图。
 *
 *  DDL(与 ensureTable 一致,也可手动执行):
 *    CREATE TABLE IF NOT EXISTS festival_submissions (
 *      id            INT AUTO_INCREMENT PRIMARY KEY,
 *      customer_id   VARCHAR(32)  NOT NULL,
 *      festival_id   VARCHAR(32)  NOT NULL,
 *      url           VARCHAR(255) NOT NULL UNIQUE,
 *      status        ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
 *      reject_reason VARCHAR(255) DEFAULT NULL,
 *      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *      reviewed_at   TIMESTAMP NULL DEFAULT NULL,
 *      INDEX idx_status_festival (status, festival_id),
 *      INDEX idx_customer (customer_id)
 *    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
 */

const UPLOAD_ROOT = '/www/wwwroot/47.103.65.4/images/user-festival';
const URL_PREFIX = '/images/user-festival';
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;   // 单张解码后上限 8MB
export const MAX_UPLOADS_PER_CUSTOMER = 20;         // 每客户最多保留 20 张(含审核中/已通过/被驳回)

const CUSTOMER_ID_RE = /^[A-Za-z0-9]{1,32}$/;

export type SubmissionStatus = 'pending' | 'approved' | 'rejected';

export interface FestivalSubmission {
  id: number;
  customerId: string;
  festivalId: FestivalId;
  festivalLabel: string;
  url: string;                 // 相对路径,前端拼 STATIC_BASE_URL
  status: SubmissionStatus;
  rejectReason: string | null;
  createdAt: string | null;
  reviewedAt: string | null;
}

interface SubmissionRow extends RowDataPacket {
  id: number;
  customer_id: string;
  festival_id: string;
  url: string;
  status: SubmissionStatus;
  reject_reason: string | null;
  created_at: Date | string | null;
  reviewed_at: Date | string | null;
}

export class UploadError extends Error {}

export function isValidCustomerId(id: unknown): id is string {
  return typeof id === 'string' && CUSTOMER_ID_RE.test(id);
}

export function isValidFestivalId(id: unknown): id is FestivalId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(FESTIVAL_META, id);
}

let tableReady: Promise<void> | null = null;
/** 首次使用时建表(幂等);失败则下次重试。 */
function ensureTable(): Promise<void> {
  if (tableReady) return tableReady;
  const p: Promise<void> = pool.query(`
    CREATE TABLE IF NOT EXISTS festival_submissions (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      customer_id   VARCHAR(32)  NOT NULL,
      festival_id   VARCHAR(32)  NOT NULL,
      url           VARCHAR(255) NOT NULL UNIQUE,
      status        ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      reject_reason VARCHAR(255) DEFAULT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reviewed_at   TIMESTAMP NULL DEFAULT NULL,
      INDEX idx_status_festival (status, festival_id),
      INDEX idx_customer (customer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).then(() => undefined).catch((err: unknown) => {
    tableReady = null;
    throw err;
  });
  tableReady = p;
  return p;
}

function fmtTime(v: Date | string | null): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toSubmission(r: SubmissionRow): FestivalSubmission {
  const fid = r.festival_id as FestivalId;
  return {
    id: Number(r.id),
    customerId: r.customer_id,
    festivalId: fid,
    festivalLabel: FESTIVAL_META[fid] ? FESTIVAL_META[fid].label : r.festival_id,
    url: r.url,
    status: r.status,
    rejectReason: r.reject_reason,
    createdAt: fmtTime(r.created_at),
    reviewedAt: fmtTime(r.reviewed_at),
  };
}

/** 魔数判图:PNG / JPEG,其余一律拒收。 */
function detectExt(buf: Buffer): 'png' | 'jpg' | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}

/** url → 服务器本地文件路径;url 不在投稿目录下返回 null。 */
function localPathOf(url: string): string | null {
  if (!url.startsWith(URL_PREFIX + '/')) return null;
  const rel = url.slice(URL_PREFIX.length + 1);
  if (!/^[A-Za-z0-9]{1,32}\/\d{13}_[0-9a-f]{6}\.(?:png|jpg)$/.test(rel)) return null;
  return path.join(UPLOAD_ROOT, rel);
}

function removeFile(url: string): void {
  const p = localPathOf(url);
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
}

/* ======================== 客户侧 ======================== */

/** 客户投稿一张(base64)。类型/大小/数量不合规抛 UploadError(文案直接给前端)。 */
export async function submitFestivalImage(
  customerId: string,
  festivalId: FestivalId,
  base64: string,
): Promise<FestivalSubmission> {
  await ensureTable();
  const buf = Buffer.from(base64.replace(/^data:image\/[a-z]+;base64,/i, ''), 'base64');
  if (buf.length === 0) throw new UploadError('图片内容为空');
  if (buf.length > MAX_UPLOAD_BYTES) throw new UploadError('图片过大,请控制在 8MB 以内');
  const ext = detectExt(buf);
  if (!ext) throw new UploadError('仅支持 JPG / PNG 图片');

  const [cnt] = await pool.execute<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM festival_submissions WHERE customer_id = ?',
    [customerId],
  );
  if (Number(cnt[0].n) >= MAX_UPLOADS_PER_CUSTOMER) {
    throw new UploadError(`最多保存 ${MAX_UPLOADS_PER_CUSTOMER} 张,请先删除不用的图片`);
  }

  const dir = path.join(UPLOAD_ROOT, customerId);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
  const url = `${URL_PREFIX}/${customerId}/${file}`;
  fs.writeFileSync(path.join(dir, file), buf);
  try {
    const [ret] = await pool.execute<ResultSetHeader>(
      'INSERT INTO festival_submissions (customer_id, festival_id, url) VALUES (?, ?, ?)',
      [customerId, festivalId, url],
    );
    const [rows] = await pool.execute<SubmissionRow[]>('SELECT * FROM festival_submissions WHERE id = ?', [ret.insertId]);
    return toSubmission(rows[0]);
  } catch (err) {
    removeFile(url);  // 落库失败不留孤儿文件
    throw err;
  }
}

/** 节日弹窗数据:本客户在该节日的投稿(含状态) + 他人已通过的公共图。 */
export async function listFestivalImages(
  customerId: string,
  festivalId: FestivalId,
): Promise<{ mine: FestivalSubmission[]; shared: FestivalSubmission[] }> {
  await ensureTable();
  const [mine] = await pool.execute<SubmissionRow[]>(
    `SELECT * FROM festival_submissions WHERE customer_id = ? AND festival_id = ? ORDER BY id DESC`,
    [customerId, festivalId],
  );
  const [shared] = await pool.execute<SubmissionRow[]>(
    `SELECT * FROM festival_submissions
      WHERE status = 'approved' AND festival_id = ? AND customer_id <> ?
      ORDER BY reviewed_at DESC, id DESC`,
    [festivalId, customerId],
  );
  return { mine: mine.map(toSubmission), shared: shared.map(toSubmission) };
}

/** 客户撤回/删除自己的一张投稿(含已通过的,随之从公共素材下架)。非本人或不存在返回 false。 */
export async function deleteOwnSubmission(customerId: string, id: number): Promise<boolean> {
  await ensureTable();
  const [rows] = await pool.execute<SubmissionRow[]>(
    'SELECT * FROM festival_submissions WHERE id = ? AND customer_id = ?',
    [id, customerId],
  );
  if (rows.length === 0) return false;
  await pool.execute('DELETE FROM festival_submissions WHERE id = ?', [id]);
  removeFile(rows[0].url);
  return true;
}

/** generate 用:该 URL 对此客户是否可用(已通过 = 所有人可用;审核中 = 仅投稿人本人可用)。可用原样返回,否则 null。 */
export async function resolveFestivalUploadUrl(
  customerId: string | undefined,
  url: string | undefined,
): Promise<string | null> {
  if (!url || !localPathOf(url)) return null;
  try {
    await ensureTable();
    const [rows] = await pool.execute<SubmissionRow[]>(
      `SELECT * FROM festival_submissions
        WHERE url = ? AND (status = 'approved' OR (status = 'pending' AND customer_id = ?))`,
      [url, customerId || ''],
    );
    if (rows.length === 0) return null;
    const p = localPathOf(url);
    return p && fs.existsSync(p) ? url : null;
  } catch (err) {
    console.error('[festival-uploads] resolve 失败,回退自动选图:', err);
    return null;
  }
}

/* ======================== 后台审核侧 ======================== */

/** 审核列表:按状态筛(缺省 pending),新的在前。 */
export async function listSubmissionsForReview(status: SubmissionStatus | 'all'): Promise<FestivalSubmission[]> {
  await ensureTable();
  const [rows] = status === 'all'
    ? await pool.execute<SubmissionRow[]>('SELECT * FROM festival_submissions ORDER BY id DESC LIMIT 500')
    : await pool.execute<SubmissionRow[]>(
      'SELECT * FROM festival_submissions WHERE status = ? ORDER BY id DESC LIMIT 500',
      [status],
    );
  return rows.map(toSubmission);
}

/** 各状态计数(审核页徽标用)。 */
export async function countSubmissionsByStatus(): Promise<Record<SubmissionStatus, number>> {
  await ensureTable();
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT status, COUNT(*) AS n FROM festival_submissions GROUP BY status',
  );
  const out: Record<SubmissionStatus, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const r of rows) out[r.status as SubmissionStatus] = Number(r.n);
  return out;
}

/** 审核:通过(可顺带改节日标签)/ 驳回(附原因)。不存在返回 false。 */
export async function reviewSubmission(
  id: number,
  action: 'approve' | 'reject',
  opts: { reason?: string; festivalId?: FestivalId } = {},
): Promise<boolean> {
  await ensureTable();
  const [ret] = action === 'approve'
    ? await pool.execute<ResultSetHeader>(
      `UPDATE festival_submissions
          SET status = 'approved', reject_reason = NULL, reviewed_at = NOW(),
              festival_id = COALESCE(?, festival_id)
        WHERE id = ?`,
      [opts.festivalId || null, id],
    )
    : await pool.execute<ResultSetHeader>(
      `UPDATE festival_submissions
          SET status = 'rejected', reject_reason = ?, reviewed_at = NOW()
        WHERE id = ?`,
      [(opts.reason || '').slice(0, 255) || null, id],
    );
  return ret.affectedRows > 0;
}

/** 后台彻底删除一张投稿(记录 + 文件)。 */
export async function deleteSubmissionById(id: number): Promise<boolean> {
  await ensureTable();
  const [rows] = await pool.execute<SubmissionRow[]>('SELECT * FROM festival_submissions WHERE id = ?', [id]);
  if (rows.length === 0) return false;
  await pool.execute('DELETE FROM festival_submissions WHERE id = ?', [id]);
  removeFile(rows[0].url);
  return true;
}
