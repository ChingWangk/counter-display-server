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

/** ref_market_coverage / ref_order_fill_rate 取数行(每月快照,取最新月)。 */
interface MetricRow extends RowDataPacket {
  spec_id: string;
  val: number | string | null;
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
 * 取某月度快照 ref 表"最新 snapshot_month"的 spec_id → 数值 Map(用于铺市面/订足率)。
 * 表/列名为本模块写死常量(非用户输入,无注入风险)。表未就绪(ER_NO_SUCH_TABLE)→ 空 Map。
 */
async function fetchLatestMetricMap(table: string, valueCol: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const [rows] = await pool.execute<MetricRow[]>(
      `SELECT spec_id, ${valueCol} AS val FROM ${table}
        WHERE snapshot_month = (SELECT MAX(snapshot_month) FROM ${table})`
    );
    for (const r of rows) {
      const n = toNum(r.val);
      if (n != null) map.set(r.spec_id, n);
    }
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw err;
  }
  return map;
}

/**
 * 合并 categories.json 基础字段 + dim_category_ext 扩展字段 + 铺市面/订足率(ref 表),5 分钟 TTL 缓存。
 * dim_category_ext 表未就绪（ER_NO_SUCH_TABLE）时降级返回纯基础数据,扩展字段保持 undefined。
 * 铺市面(ref_market_coverage)/ 订足率(ref_order_fill_rate)取各自最新 snapshot_month,叠加到 Category
 * 的 market_coverage / order_fill_rate(供爆珠子专区排序);两表缺数据则这两项为空 → 爆珠按价格兜底。
 * 用于专区策略（滞销 / 怀旧 / 尝鲜 / 爆珠等）需要 tier / launch_date / is_delisted / flavor / 指标等的场景。
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
      console.warn('[categoryCatalog] dim_category_ext 表未就绪,返回基础品类(扩展字段为空)');
    } else {
      throw err;
    }
  }

  // 铺市面/订足率来自独立 ref 表(与 dim_category_ext 解耦),各取最新月快照。
  const [coverageMap, fillMap] = await Promise.all([
    fetchLatestMetricMap('ref_market_coverage', 'coverage_rate'),
    fetchLatestMetricMap('ref_order_fill_rate', 'fill_rate'),
  ]);

  const merged = new Map<string, Category>();
  for (const c of baseCategories) {
    const e = ext.get(c.id);
    const base: Category = e ? {
      ...c,
      pack_type: e.pack_type,
      flavor: e.flavor,
      tier: e.tier,
      launch_date: toDateStr(e.launch_date),
      is_industrial_coop: Boolean(e.is_industrial_coop),
      is_delisted: Boolean(e.is_delisted),
      successor_id: e.successor_id,
    } : { ...c };
    const mc = coverageMap.get(c.id);
    const fr = fillMap.get(c.id);
    if (mc != null) base.market_coverage = mc;
    if (fr != null) base.order_fill_rate = fr;
    merged.set(c.id, base);
  }
  extendedMap = merged;
  extendedLoadedAt = Date.now();
  return merged;
}

export async function getExtendedCategoryList(): Promise<Category[]> {
  const m = await getExtendedCategoryMap();
  return Array.from(m.values());
}
