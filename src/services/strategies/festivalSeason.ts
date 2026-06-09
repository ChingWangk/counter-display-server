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
 *  - 排序(5 层 desc,新版加入 ruleScore 居首):
 *      1. ruleScore —— 命中所选节日 rules 的条数(春节优先红色礼盒;端午偏礼盒;清明偏怀旧;...)
 *      2. isHighTier (tier ∈ {一类, 二类})
 *      3. ref_quarterly_wholesale_rank.wholesale_qty(最新季度)
 *      4. matchesSeason —— 夏秋 = pack_type 含'爆珠' && flavor === '薄荷'; 冬春 = pack_type 含'短支'
 *      5. price
 *  - 取 Top 1,返回 `/images/back-festival/{fileName}` 作为整张背柜图(单图直出)。
 *
 * festival_id 通过 FESTIVAL_RULES_MAP 翻译成 rules 关键词,然后逐条匹配 Category 字段产生 ruleScore。
 * rules 关键词来源:`sys_season_calendar` 维护报告(标准数据/系统级/维护输出/季节日历维护报告.md)。
 */

const IMAGE_DIR = '/www/wwwroot/47.103.65.4/images/back-festival';
const IMAGE_URL_PREFIX = '/images/back-festival';
const HIGH_TIERS = new Set(['一类', '二类']);
const CACHE_TTL_MS = 5 * 60 * 1000;

type SeasonType = 'summerAutumn' | 'winterSpring';

/** 每个节日适用的 rules(来源:标准数据/系统级 季节日历维护报告)。
 *  nationalDay / chongyang 季节日历未列入,按业务常识设默认:
 *   - 国庆:高价烟前置 + 沪产专区前置(双节同庆,沪产烟好卖)
 *   - 重阳:怀旧专区前置 + 经典老牌(敬老节,长辈爱老味道) */
const FESTIVAL_RULES_MAP: Record<FestivalId, string[]> = {
  newYear:         ['高价烟前置', '沪产专区前置'],
  springFestival:  ['高价烟前置', '礼盒精品', '沪产专区前置', '中华熊猫前置'],
  lanternFestival: ['高价烟前置', '礼盒精品'],
  qingming:        ['怀旧专区前置', '经典老牌'],
  dragonBoat:      ['高价烟前置', '礼盒精品', '沪产专区前置'],
  midAutumn:       ['高价烟前置', '礼盒精品', '沪产专区前置', '中华熊猫前置'],
  nationalDay:     ['高价烟前置', '沪产专区前置'],
  chongyang:       ['怀旧专区前置', '经典老牌'],
};

const HU_BRANDS = new Set(['中华', '熊猫']);

/** 单个 rule 关键词作用在 Category 上,返回 0/1。多条 rule 累加得 ruleScore。
 *  字段缺失视为不命中,不报错(开发环境兼容)。 */
function matchRule(rule: string, c: Category, now: Date): boolean {
  switch (rule) {
    case '高价烟前置':
    case '一类烟前置':
    case '礼盒精品':
      return HIGH_TIERS.has(c.tier ?? '');
    case '沪产专区前置':
      return c.manufacturer === '上海烟草集团';
    case '中华熊猫前置':
      return HU_BRANDS.has(c.brand ?? '');
    case '怀旧专区前置':
      return c.is_delisted === true;
    case '经典老牌':
      return !!c.launch_date && c.launch_date < '2010-01-01';
    case '新品推荐前置':
      return !!c.launch_date && monthsBetween(c.launch_date, now) <= 3;
    case '时尚新品前置':
      return !!c.launch_date && monthsBetween(c.launch_date, now) <= 6;
    case '薄荷爆珠优先':
      return c.flavor === '薄荷' && (c.pack_type ?? '').includes('爆珠');
    case '水果爆珠':
    case '爆珠水果':
      return c.flavor === '水果' && (c.pack_type ?? '').includes('爆珠');
    case '中支偏好':
      return (c.pack_type ?? '').includes('中支');
    case '细支偏好':
      return (c.pack_type ?? '').includes('细支');
    case '中支细支偏好':
      return (c.pack_type ?? '').includes('中支') || (c.pack_type ?? '').includes('细支');
    default:
      // 无字段支撑的 rule(低焦/口感/包装/全品类促销)直接跳过,不贡献分数
      return false;
  }
}

function monthsBetween(dateStr: string, now: Date): number {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Number.POSITIVE_INFINITY;
  const ms = now.getTime() - d.getTime();
  return ms / (1000 * 60 * 60 * 24 * 30);
}

interface Candidate {
  specId: string;
  fileName: string;
  isPreferred: boolean;
  ruleScore: number;
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
 * @param festivalId        用户选的节日,通过 FESTIVAL_RULES_MAP 翻译成 rules 关键词参与排序首层
 * @param customerSpecIds   客户在售/勾选范围内的 spec_id 集合;候选必须落在此集合内
 * @param extendedMap       全量 catalog(含 ext 字段),用于查 tier/pack_type/flavor/price
 * @param now               今天的日期,决定季节(夏秋/冬春)
 * @param excludeImageUrls  已在其他背柜用过的图片 URL,本次跳过(用于跨背柜去重)
 * @param preferredSpecId   用户为本背柜显式选定的商品(zone-select 单选);命中其变体则置顶选用,
 *                          且**不受 customerSpecIds 在售范围限制**(用户既已挑明)。其变体被去重占用尽时,
 *                          自然回退到其余候选(= 自动选图),不让该柜空着。
 * @returns 完整 URL 路径(如 `/images/back-festival/12345_1.png`);无可用图片时返回 null
 */
export async function selectFestivalImage(
  festivalId: FestivalId,
  customerSpecIds: ReadonlySet<string>,
  extendedMap: ReadonlyMap<string, Category>,
  now: Date = new Date(),
  excludeImageUrls: ReadonlySet<string> = new Set(),
  preferredSpecId?: string | null,
): Promise<string | null> {
  const imageIndex = getImageIndex();
  if (imageIndex.size === 0) return null;

  const wholesaleMap = await fetchLatestWholesaleQty();
  const season = getSeason(now);
  const rules = FESTIVAL_RULES_MAP[festivalId] || [];

  const candidates: Candidate[] = [];
  for (const [specId, fileNames] of imageIndex) {
    const isPreferred = preferredSpecId != null && specId === preferredSpecId;
    // 显式选中的 spec 不受在售范围限制;其余候选仍需落在客户在售/勾选范围内。
    if (!isPreferred && !customerSpecIds.has(specId)) continue;
    const cat = extendedMap.get(specId);
    if (!cat) continue;
    // 命中节日 rules 的条数(春节 4 条规则全中 → 4 分;端午全中 → 3 分;...)
    let ruleScore = 0;
    for (const rule of rules) {
      if (matchRule(rule, cat, now)) ruleScore++;
    }
    for (const fileName of fileNames) {
      // 跨背柜去重:已被前一张背柜选走的图片 URL 在本次直接排除
      if (excludeImageUrls.has(`${IMAGE_URL_PREFIX}/${fileName}`)) continue;
      candidates.push({
        specId,
        fileName,
        isPreferred,
        ruleScore,
        isHighTier: HIGH_TIERS.has(cat.tier ?? ''),
        wholesale: wholesaleMap.get(specId) ?? 0,
        matchesSeason: matchesSeason(cat, season),
        price: cat.price ?? 0,
      });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // 用户显式选定的商品置顶(仅 preferredSpecId 存在时该层才有区分度)
    if (a.isPreferred !== b.isPreferred) return a.isPreferred ? -1 : 1;
    if (a.ruleScore !== b.ruleScore) return b.ruleScore - a.ruleScore;
    if (a.isHighTier !== b.isHighTier) return a.isHighTier ? -1 : 1;
    if (a.wholesale !== b.wholesale) return b.wholesale - a.wholesale;
    if (a.matchesSeason !== b.matchesSeason) return a.matchesSeason ? -1 : 1;
    return b.price - a.price;
  });

  return `${IMAGE_URL_PREFIX}/${candidates[0].fileName}`;
}

/**
 * 列出"可选节日商品"——所有有 back-festival 图片素材的 spec(= 有商品编码的商品),
 * 供 zone-select 弹窗让用户为某背柜单选一个具体礼盒图。前端显示 name,缩略图用首个变体图。
 *  - name:catalog(categories.json/ext)有则用其商品名,无则用编码兜底(始终有可显示文案)。
 *  - thumbUrl:`/images/back-festival/{首个变体文件}`(前端拼 STATIC_BASE_URL)。
 *  - 不限客户在售范围(贴合"有编码的商品"口径);按 name 升序稳定。
 */
export function listFestivalSelectableSpecs(
  extendedMap: ReadonlyMap<string, Category>,
): { id: string; name: string; thumbUrl: string }[] {
  const imageIndex = getImageIndex();
  const out: { id: string; name: string; thumbUrl: string }[] = [];
  for (const [specId, fileNames] of imageIndex) {
    if (fileNames.length === 0) continue;
    const name = extendedMap.get(specId)?.name ?? specId;
    out.push({ id: specId, name, thumbUrl: `${IMAGE_URL_PREFIX}/${fileNames[0]}` });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return out;
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
