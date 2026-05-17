import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import pool from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface BaseCategory {
  id: string;
  name: string;
  imageUrl: string;
  brand?: string;
  is_hot?: boolean;
  price?: number;
  manufacturer?: string;
  category?: string;
  province?: string | null;
}

interface ExtRow extends RowDataPacket {
  spec_id: string;
  pack_type: string;
  flavor: string | null;
  tier: string | null;
  launch_date: Date | string | null;
  is_industrial_coop: number;
  is_delisted: number;
  successor_id: string | null;
}

let extCache: Map<string, ExtRow> | null = null;
let extCacheLoadedAt = 0;
const EXT_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 分钟

async function loadExtCache(): Promise<Map<string, ExtRow>> {
  if (extCache && Date.now() - extCacheLoadedAt < EXT_CACHE_TTL_MS) return extCache;
  try {
    const [rows] = await pool.execute<ExtRow[]>(
      `SELECT spec_id, pack_type, flavor, tier, launch_date,
              is_industrial_coop, is_delisted, successor_id
         FROM dim_category_ext`
    );
    const map = new Map<string, ExtRow>();
    for (const r of rows) map.set(r.spec_id, r);
    extCache = map;
    extCacheLoadedAt = Date.now();
    return map;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[categories] dim_category_ext not ready, returning bare categories');
      return new Map();
    }
    throw err;
  }
}

function toDateStr(d: Date | string | null): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}

/** GET /api/categories — 合并 categories.json + dim_category_ext
 *
 * 返回字段：
 *  - 原 categories.json 字段（id/name/imageUrl/brand/price/manufacturer/category/province/is_hot）
 *  - 来自 dim_category_ext：pack_type / flavor / tier / launch_date / is_industrial_coop / is_delisted / successor_id
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const filePath = path.join(__dirname, '../data/categories.json');
    const base: BaseCategory[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const ext = await loadExtCache();

    const merged = base.map(c => {
      const e = ext.get(c.id);
      return e ? {
        ...c,
        pack_type: e.pack_type,
        flavor: e.flavor,
        tier: e.tier,
        launch_date: toDateStr(e.launch_date),
        is_industrial_coop: Boolean(e.is_industrial_coop),
        is_delisted: Boolean(e.is_delisted),
        successor_id: e.successor_id,
      } : c;
    });

    res.json({ success: true, categories: merged });
  } catch (err) {
    console.error('Query categories error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
