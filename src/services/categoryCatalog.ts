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
  market_coverage: number | string | null;
  order_fill_rate: number | string | null;
}

let extendedMap: Map<string, Category> | null = null;
let extendedLoadedAt = 0;
const EXT_CACHE_TTL_MS = 5 * 60 * 1000;

function toDateStr(d: Date | string | null): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}

/** DECIMAL 列经 mysql2 可能回传字符串;统一转 number,null/空 → null。 */
function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 合并 categories.json 基础字段 + dim_category_ext 扩展字段，5 分钟 TTL 缓存。
 * 表未就绪（ER_NO_SUCH_TABLE）时降级返回纯基础数据，扩展字段保持 undefined。
 * 新列（market_coverage/order_fill_rate）尚未 ALTER 时（ER_BAD_FIELD_ERROR）回退到旧列集，
 * 仅这两项为空、其余 ext 字段照常合并——避免"加了代码没加列"导致所有专区(工商共育/爆珠/升级…)消失。
 * 用于专区策略（滞销 / 怀旧 / 尝鲜 / 爆珠等）需要 tier / launch_date / is_delisted / flavor 等的场景。
 */
export async function getExtendedCategoryMap(): Promise<Map<string, Category>> {
  if (extendedMap && Date.now() - extendedLoadedAt < EXT_CACHE_TTL_MS) {
    return extendedMap;
  }

  // 旧列集(不含 market_coverage/order_fill_rate);新列存在时附加之。
  const LEGACY_COLS = 'spec_id, pack_type, flavor, tier, launch_date, is_industrial_coop, is_delisted, successor_id';
  const FULL_COLS = `${LEGACY_COLS}, market_coverage, order_fill_rate`;

  const ext = new Map<string, ExtRow>();
  try {
    let rows: ExtRow[];
    try {
      [rows] = await pool.execute<ExtRow[]>(`SELECT ${FULL_COLS} FROM dim_category_ext`);
    } catch (err: unknown) {
      // 新列尚未 ALTER:回退旧列(保住 pack_type/flavor/is_industrial_coop 等),两项指标置空 → 爆珠暂按价格排。
      if ((err as { code?: string }).code === 'ER_BAD_FIELD_ERROR') {
        console.warn('[categoryCatalog] market_coverage/order_fill_rate 列缺失,回退旧列(爆珠暂按价格排序)。请执行 bead-subzone-ext.sql 加列。');
        [rows] = await pool.execute<ExtRow[]>(`SELECT ${LEGACY_COLS} FROM dim_category_ext`);
      } else {
        throw err;
      }
    }
    for (const r of rows) ext.set(r.spec_id, r);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    // 表整体未就绪:仅此情形才降级为"纯基础数据"(扩展字段全空)。
    if (code === 'ER_NO_SUCH_TABLE') {
      console.warn('[categoryCatalog] dim_category_ext 表未就绪,返回基础品类(扩展字段为空)');
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
      market_coverage: toNum(e.market_coverage),
      order_fill_rate: toNum(e.order_fill_rate),
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
