import * as fs from 'fs';
import * as path from 'path';
import { RowDataPacket } from 'mysql2';
import pool from '../db';
import { Category } from '../types';

/** 全量品类目录单例：进程启动时加载一次，所有策略/路由共用同一份引用。 */
const categoriesFile = path.join(__dirname, '../data/categories.json');
const baseCategories: Category[] = JSON.parse(fs.readFileSync(categoriesFile, 'utf-8'));

export const categoryMap = new Map<string, Category>(baseCategories.map(c => [c.id, c]));
export const allCategoryList: ReadonlyArray<Category> = baseCategories;

/** dim_category_ext 行结构 */
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

let extendedMap: Map<string, Category> | null = null;
let extendedLoadedAt = 0;
const EXT_CACHE_TTL_MS = 5 * 60 * 1000;

function toDateStr(d: Date | string | null): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}

/**
 * 合并 categories.json 基础字段 + dim_category_ext 扩展字段，5 分钟 TTL 缓存。
 * 表未就绪（ER_NO_SUCH_TABLE）时降级返回纯基础数据，扩展字段保持 undefined。
 * 用于专区策略（滞销 / 怀旧 / 尝鲜）需要 tier / launch_date / is_delisted 等的场景。
 */
export async function getExtendedCategoryMap(): Promise<Map<string, Category>> {
  if (extendedMap && Date.now() - extendedLoadedAt < EXT_CACHE_TTL_MS) {
    return extendedMap;
  }

  const ext = new Map<string, ExtRow>();
  try {
    const [rows] = await pool.execute<ExtRow[]>(
      `SELECT spec_id, pack_type, flavor, tier, launch_date,
              is_industrial_coop, is_delisted, successor_id
         FROM dim_category_ext`
    );
    for (const r of rows) ext.set(r.spec_id, r);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[categoryCatalog] dim_category_ext not ready, returning base categories');
    } else {
      throw err;
    }
  }

  const merged = new Map<string, Category>();
  for (const c of baseCategories) {
    const e = ext.get(c.id);
    merged.set(c.id, e ? {
      ...c,
      pack_type: e.pack_type,
      flavor: e.flavor,
      tier: e.tier,
      launch_date: toDateStr(e.launch_date),
      is_industrial_coop: Boolean(e.is_industrial_coop),
      is_delisted: Boolean(e.is_delisted),
      successor_id: e.successor_id,
    } : c);
  }
  extendedMap = merged;
  extendedLoadedAt = Date.now();
  return merged;
}

export async function getExtendedCategoryList(): Promise<Category[]> {
  const m = await getExtendedCategoryMap();
  return Array.from(m.values());
}
