import pool from '../db';
import { RowDataPacket } from 'mysql2';
import { getExtendedCategoryMap } from './categoryCatalog';

/**
 * 产品升级「组合明细」取数（供 agent-chat 升级组合表）：
 *  - 各自零售价（老品/升级款，取 dim_category_ext.price = 含税零售指导价/包）
 *  - 每包多赚 = 升级款零售价 − 老品零售价（>0 才算"多赚"，否则 null）
 *  - 升级桥梁：品牌 / 支型 / 口味（老品与升级款所共有的那一维，优先级 品牌>支型>口味）
 *  - 结构档位 tierOld→tierUp（供前端拼"升级依据"）
 *
 * 红线：只用真实数据，价格缺失即 null（前端降级 '—'），绝不硬拼。表/列未就绪也不抛错。
 */

export interface UpgradePair {
  oldId: string;
  upId: string;
}

export interface UpgradeDetail {
  oldId: string;
  upId: string;
  priceOld: number | null;      // 老品零售价/包
  priceUp: number | null;       // 升级款零售价/包
  profitPerPack: number | null; // 每包多赚(升级款−老品，>0 才给，否则 null)
  bridge: '品牌' | '支型' | '口味' | null;  // 升级桥梁
  tierOld: string | null;
  tierUp: string | null;
}

interface PriceRow extends RowDataPacket {
  spec_id: string;
  price: number | string | null;
}

/** 读 dim_category_ext.price（含税零售指导价/包）。表/列未就绪 → 空 Map（价格降级 null）。 */
async function fetchRetailPrices(specIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (specIds.length === 0) return map;
  try {
    const placeholders = specIds.map(() => '?').join(',');
    const [rows] = await pool.execute<PriceRow[]>(
      `SELECT spec_id, price FROM dim_category_ext WHERE spec_id IN (${placeholders})`,
      specIds,
    );
    for (const r of rows) {
      if (r.price == null) continue;
      const n = typeof r.price === 'number' ? r.price : parseFloat(r.price);
      if (Number.isFinite(n)) map.set(r.spec_id, n);
    }
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== 'ER_NO_SUCH_TABLE' && code !== 'ER_BAD_FIELD_ERROR') {
      console.error('[upgradeDetail] fetch prices error:', err);
    }
  }
  return map;
}

/** 升级桥梁：老品与升级款共有的维度，优先级 品牌 > 支型 > 口味；都不共有则 null。 */
function decideBridge(
  brandOld: string | null | undefined, brandUp: string | null | undefined,
  packOld: string | null | undefined, packUp: string | null | undefined,
  flavorOld: string | null | undefined, flavorUp: string | null | undefined,
): UpgradeDetail['bridge'] {
  if (brandOld && brandUp && brandOld === brandUp) return '品牌';
  if (packOld && packUp && packOld === packUp) return '支型';
  if (flavorOld && flavorUp && flavorOld === flavorUp) return '口味';
  return null;
}

export async function getUpgradeDetails(pairs: UpgradePair[]): Promise<UpgradeDetail[]> {
  if (pairs.length === 0) return [];
  const catMap = await getExtendedCategoryMap();
  const allIds = Array.from(new Set(pairs.flatMap(p => [p.oldId, p.upId])));
  const priceMap = await fetchRetailPrices(allIds);

  return pairs.map(({ oldId, upId }) => {
    const o = catMap.get(oldId);
    const u = catMap.get(upId);
    const priceOld = priceMap.has(oldId) ? priceMap.get(oldId)! : null;
    const priceUp = priceMap.has(upId) ? priceMap.get(upId)! : null;
    const diff = priceOld != null && priceUp != null ? priceUp - priceOld : null;
    return {
      oldId,
      upId,
      priceOld,
      priceUp,
      profitPerPack: diff != null && diff > 0 ? Math.round(diff * 100) / 100 : null,
      bridge: decideBridge(o?.brand, u?.brand, o?.pack_type, u?.pack_type, o?.flavor, u?.flavor),
      tierOld: o?.tier ?? null,
      tierUp: u?.tier ?? null,
    };
  });
}
