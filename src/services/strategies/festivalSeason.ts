import * as fs from 'fs';
import pool from '../../db';
import { RowDataPacket } from 'mysql2';
import { Category } from '../../types';
import { FestivalId } from './types';

/**
 * 节日季节专区选图策略 —— 单图直出,与其他 zone 数据流隔离。
 *
 * 设计:
 *  - 图片素材:`/www/wwwroot/47.103.65.4/images/back-festival/{spec_id}.png` 或 `{spec_id}_x.png`
 *    单图直接命名 `{spec_id}.png`;多变体在 _ 后加任意字符(如 12345_1.png / 12345_2.png)。
 *    扩展名 .png / .jpg / .jpeg 都支持(大小写不敏感)。
 *  - 候选 = (spec_id × 该 spec 的所有变体图);spec_id 必须在客户在售/勾选范围内。
 *  - 排序(4 层 desc):
 *      1. isHighTier (tier ∈ {一类, 二类})
 *      2. ref_quarterly_wholesale_rank.wholesale_qty(最新季度)
 *      3. matchesSeason —— 夏秋 = pack_type 含'爆珠' && flavor === '薄荷'; 冬春 = pack_type 含'短支'
 *      4. price
 *  - 取 Top 1,返回 `/images/back-festival/{fileName}` 作为整张背柜图(单图直出)。
 *
 * 节日参数(festivalId)目前不参与排序,仅作为接口契约保留;未来如需"节日→spec 偏好"
 * (如春节优先红包装)可在此扩展。
 */

const IMAGE_DIR = '/www/wwwroot/47.103.65.4/images/back-festival';
const IMAGE_URL_PREFIX = '/images/back-festival';
const HIGH_TIERS = new Set(['一类', '二类']);
const CACHE_TTL_MS = 5 * 60 * 1000;

type SeasonType = 'summerAutumn' | 'winterSpring';

interface Candidate {
  specId: string;
  fileName: string;
  isHighTier: boolean;
  wholesale: number;
  matchesSeason: boolean;
  price: number;
}

interface WholesaleRow extends RowDataPacket {
  spec_id: string;
  wholesale_qty: number;
}

let imageIndexCache: Map<string, string[]> | null = null;
let imageIndexCachedAt = 0;

/** 扫目录,文件名匹配 `{spec_id}_x.jpg` —— 首段下划线前的字符串作为 spec_id。 */
function buildImageIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  if (!fs.existsSync(IMAGE_DIR)) return index;
  for (const file of fs.readdirSync(IMAGE_DIR)) {
    // 命名约束:`{spec_id}.png`(单图) 或 `{spec_id}_x.png`(多变体,_ 后可任意字符);spec_id 限字母数字
    const match = file.match(/^([A-Za-z0-9]+)(?:_[^.]*)?\.(?:png|jpe?g)$/i);
    if (!match) continue;
    const specId = match[1];
    const arr = index.get(specId) || [];
    arr.push(file);
    index.set(specId, arr);
  }
  // 同 spec 多变体的相对顺序固定下来(字典序),保证选图结果确定
  for (const arr of index.values()) arr.sort();
  return index;
}

function getImageIndex(): Map<string, string[]> {
  const now = Date.now();
  if (!imageIndexCache || now - imageIndexCachedAt > CACHE_TTL_MS) {
    imageIndexCache = buildImageIndex();
    imageIndexCachedAt = now;
  }
  return imageIndexCache;
}

/** 运维手动新增/重命名图片后调用一次,使下次选图立即看到新文件。 */
export function refreshFestivalImageIndex(): void {
  imageIndexCache = null;
}

/** 5/15 – 11/15 为夏秋,其余为冬春。临界日按 ≥/≤ 处理。 */
function getSeason(now: Date): SeasonType {
  const month = now.getMonth() + 1;
  const day = now.getDate();
  if (month > 5 && month < 11) return 'summerAutumn';
  if (month === 5 && day >= 15) return 'summerAutumn';
  if (month === 11 && day <= 15) return 'summerAutumn';
  return 'winterSpring';
}

function matchesSeason(c: Category, season: SeasonType): boolean {
  const packType = c.pack_type ?? '';
  if (season === 'summerAutumn') {
    return packType.includes('爆珠') && c.flavor === '薄荷';
  }
  return packType.includes('短支');
}

/** 拉最新季度的批发量 Map<spec_id, qty>。表不存在(开发环境)时返回空 Map。 */
async function fetchLatestWholesaleQty(): Promise<Map<string, number>> {
  try {
    const [latest] = await pool.execute<RowDataPacket[]>(
      `SELECT year, quarter FROM ref_quarterly_wholesale_rank
        ORDER BY year DESC, quarter DESC LIMIT 1`
    );
    if (latest.length === 0) return new Map();
    const year = latest[0].year;
    const quarter = latest[0].quarter;
    const [rows] = await pool.execute<WholesaleRow[]>(
      `SELECT spec_id, wholesale_qty
         FROM ref_quarterly_wholesale_rank
        WHERE year = ? AND quarter = ?`,
      [year, quarter]
    );
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.spec_id, Number(r.wholesale_qty));
    return map;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') return new Map();
    throw err;
  }
}

/**
 * 选节日季节专区的背柜图。
 *
 * @param festivalId       用户选的节日(目前未参与排序,接口契约保留)
 * @param customerSpecIds  客户在售/勾选范围内的 spec_id 集合;候选必须落在此集合内
 * @param extendedMap      全量 catalog(含 ext 字段),用于查 tier/pack_type/flavor/price
 * @param now              今天的日期,决定季节(夏秋/冬春)
 * @returns 完整 URL 路径(如 `/images/back-festival/12345_1.png`);无可用图片时返回 null
 */
export async function selectFestivalImage(
  _festivalId: FestivalId,
  customerSpecIds: ReadonlySet<string>,
  extendedMap: ReadonlyMap<string, Category>,
  now: Date = new Date(),
): Promise<string | null> {
  const imageIndex = getImageIndex();
  if (imageIndex.size === 0) return null;

  const wholesaleMap = await fetchLatestWholesaleQty();
  const season = getSeason(now);

  const candidates: Candidate[] = [];
  for (const [specId, fileNames] of imageIndex) {
    if (!customerSpecIds.has(specId)) continue;
    const cat = extendedMap.get(specId);
    if (!cat) continue;
    for (const fileName of fileNames) {
      candidates.push({
        specId,
        fileName,
        isHighTier: HIGH_TIERS.has(cat.tier ?? ''),
        wholesale: wholesaleMap.get(specId) ?? 0,
        matchesSeason: matchesSeason(cat, season),
        price: cat.price ?? 0,
      });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.isHighTier !== b.isHighTier) return a.isHighTier ? -1 : 1;
    if (a.wholesale !== b.wholesale) return b.wholesale - a.wholesale;
    if (a.matchesSeason !== b.matchesSeason) return a.matchesSeason ? -1 : 1;
    return b.price - a.price;
  });

  return `${IMAGE_URL_PREFIX}/${candidates[0].fileName}`;
}

/**
 * 检查节日季节专区当前是否"可用":有图片素材 && 客户至少有 1 张可候选(spec_id 命中索引)。
 * 供 zonesAvailable.ts 判断是否在返回列表中包含 festivalSeason。
 */
export function hasFestivalCandidates(customerSpecIds: ReadonlySet<string>): boolean {
  const imageIndex = getImageIndex();
  if (imageIndex.size === 0) return false;
  for (const specId of imageIndex.keys()) {
    if (customerSpecIds.has(specId)) return true;
  }
  return false;
}
