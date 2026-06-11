import { Category } from '../../types';
import { ZonePlacement, ZonePlacementGroup, ZONE_META } from './types';

/**
 * 工商共育「条+3包+条+3包」固定陈列(fixedTop)落位构造。
 * 纯函数:入参只读,出参为新对象,无副作用,可独立单测。
 *
 * 业务规则(见 项目框架文档 工商共育章节):
 *  - 强制占据第一个展示柜台的前两行;每行 = 条+3包+条+3包 = 2 个「条单元」(每单元 = 1 条 + 3 包同规格),共 4 个单元。
 *  - 行-产地结构(用户确认,始终生效):
 *      第一行(units[0..1]) = 上海集团产地(category === 'group');
 *      第二行(units[2..3]) = 省外产地(category === 'provincial')。
 *    imageGen 的 fixedTop 分支按「2 个 group / 行」切块,故 units 顺序即 行1左、行1右、行2左、行2右。
 *  - 4 个重点规格作各行首选(同产地内最高优先级):
 *      上海集团产地:310143 → 310140;  省外产地:340136 → 450817;其余同产地按价格降序。
 *  - 缺重点规格时,「后续补全」一律用**同产地的工商共育品规**(价格降序)补;某产地无货则**借另一产地**
 *    (再不足借 foreign),仍不足则在该行内复制,保证两行恒满、不留空行(用户确认:借另一产地补满,不缩行)。
 *  - 入参 eligible 已由 generate.ts 过滤为 is_industrial_coop === true,故"补充必为工商共育品规"天然满足。
 *
 * 与改动前在「4 个重点规格齐全」「一个都没有」两种情形下结果一致(齐全时 row1=310143/310140、
 * row2=340136/450817);仅在部分缺失时改为按产地分行补全(原先是全局价格降序混排)。
 *
 * 每个条单元 = 1 个 ZonePlacementGroup(primary = 该规格, alternatives = [])。
 */

/** 工商共育各产地行内品规优先级(靠前者优先);不在列表内的同产地品规按价格降序排其后。
 *  前两个为上海集团产地(第一行首选),后两个为省外产地(第二行首选)。 */
const COOP_PRIORITY: string[] = ['310143', '310140', '340136', '450817'];

/**
 * @param eligible 已确认 is_industrial_coop 且客户在售/已选的 Category[](含 category/price,由 generate.ts 经 extendedMap 解析)
 * @param targetLevels 目标柜台层数(rowCount 上限 = min(2, levels))
 * @returns fixedTop 专区落位;无合格品规或柜台无层时返回 null。counterId 留空,由 generate.ts 赋为首个展示柜台 id。
 */
export function buildIndustrialCoopPlacement(
  eligible: ReadonlyArray<Category>,
  targetLevels: number,
): ZonePlacement | null {
  if (targetLevels <= 0) return null;

  // 1. 按 id 去重(保留首次出现,manual 模式同一品规可能重复传入)
  const seen = new Set<string>();
  const distinct: Category[] = [];
  for (const c of eligible) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    distinct.push(c);
  }
  if (distinct.length === 0) return null;

  // 2. 同产地内排序:COOP_PRIORITY 序在前(其余 +Infinity),再按价格降序;tie 保留入参顺序(JS sort 稳定)
  const prio = (id: string): number => {
    const i = COOP_PRIORITY.indexOf(id);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  const cmp = (a: Category, b: Category): number => {
    const pa = prio(a.id);
    const pb = prio(b.id);
    if (pa !== pb) return pa - pb;
    return (b.price ?? 0) - (a.price ?? 0);
  };
  const group = distinct.filter(c => c.category === 'group').sort(cmp);            // 第一行产地
  const provincial = distinct.filter(c => c.category === 'provincial').sort(cmp);  // 第二行产地
  // 外烟等非集团/非省外的工商共育品规(罕见):不属任何一行,仅在产地缺货时作借调兜底
  const rest = distinct.filter(c => c.category !== 'group' && c.category !== 'provincial').sort(cmp);

  // 3. 按行-产地填 4 个条单元:各行先用本产地(去重),不足借另一产地(再 foreign),最后行内/全局复制补满
  const used = new Set<string>();
  const take = (pool: ReadonlyArray<Category>, into: Category[], n: number): void => {
    for (const c of pool) {
      if (into.length >= n) break;
      if (used.has(c.id)) continue;
      used.add(c.id);
      into.push(c);
    }
  };
  const row1: Category[] = [];  // 上海集团产地
  const row2: Category[] = [];  // 省外产地
  // 3a. 本产地优先(distinct)
  take(group, row1, 2);
  take(provincial, row2, 2);
  // 3b. 借另一产地(distinct):行1 借省外→foreign,行2 借集团→foreign(本产地有富余时只会在 3a 占满,不会进这步)
  take([...provincial, ...rest], row1, 2);
  take([...group, ...rest], row2, 2);
  // 3c. distinct 已耗尽仍不满 2 → 行内复制(空行用全局最高优先级品规),保证两行恒满
  const fallback = distinct.slice().sort(cmp)[0];  // distinct 非空,必有值
  const fillRow = (row: Category[]): void => {
    while (row.length < 2) row.push(row[row.length - 1] ?? fallback);
  };
  fillRow(row1);
  fillRow(row2);

  // 4. 拼成 4 个条单元(行1左、行1右、行2左、行2右),按目标柜台层数裁剪行数(常态 2 行;仅 1 层时只放第一行)
  const units: Category[] = [row1[0], row1[1], row2[0], row2[1]];
  const rowCount = Math.min(2, targetLevels);
  const usedUnits = units.slice(0, rowCount * 2);
  const groups: ZonePlacementGroup[] = usedUnits.map(c => ({ primary: c, alternatives: [] }));

  const meta = ZONE_META.industrialCoop;
  return {
    zoneId: 'industrialCoop',
    label: meta.label,
    counterId: '',           // 由 generate.ts 赋为 displayCounters[0].id
    rowCount,
    groups,
    displayMode: meta.displayMode,
    layoutKind: 'fixedTop',
    barColor: meta.barColor,
    priorityRank: meta.priorityRank,
    groupCount: new Set(usedUnits.map(c => c.id)).size,  // 实际展示的去重品规数(供 result chip "X 组")
  };
}
