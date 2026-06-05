import { Category } from '../../types';
import { ZonePlacement, ZonePlacementGroup, ZONE_META } from './types';

/**
 * 工商共育「条+3包+条+3包」固定陈列(fixedTop)落位构造。
 * 纯函数:入参只读,出参为新对象,无副作用,可独立单测。
 *
 * 业务规则(见 项目框架文档 工商共育章节):
 *  - 强制占据第一个展示柜台的前两行;每行 = 条+3包+条+3包 = 2 个「条单元」(每单元 = 1 条 + 3 包同规格)。
 *  - 品规优先级:310143 → 310140 → 340136 → 450817 → 其余按价格降序。
 *  - 多于 4 个 → 只取前 4;不足 4 个 → 按优先级整行复制补满(方案 A,用户确认):
 *      4 个 → 行1[s1,s2] 行2[s3,s4]      3 个 → 行1[s1,s1] 行2[s2,s3]
 *      2 个 → 行1[s1,s1] 行2[s2,s2]      1 个 → 行1[s1,s1] 行2[s1,s1]
 *    即 unitCounts = uniformDistribute(4, min(n,4)),余数落最高优先级品规,按序展开成 4 个条单元,
 *    再每 2 个一行 —— 被复制的品规两单元必相邻同行,即「两条+6包占满整行」。
 *
 * 每个条单元 = 1 个 ZonePlacementGroup(primary = 该规格, alternatives = []),
 * imageGen 的 fixedTop 分支按 2 个 group / 行切块,绘制为 [条(5包宽)+3包] × 2。
 */

/** 工商共育品规优先级(靠前者优先);不在列表内的按价格降序排在其后。 */
const COOP_PRIORITY: string[] = ['310143', '310140', '340136', '450817'];

/** 把 total 个单元尽量均分到 bins 个品规,余数落到靠前(最高优先级)的品规。
 *  与 imageGen.uniformDistribute 同义,此处独立实现以保持本模块纯净、无 imageGen 副作用依赖。 */
function uniformDistribute(total: number, bins: number): number[] {
  if (bins <= 0) return [];
  const base = Math.floor(total / bins);
  const extra = total % bins;
  return Array.from({ length: bins }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * @param eligible 已确认 is_industrial_coop 且客户在售/已选的 Category[](含 price,由 generate.ts 经 extendedMap 解析)
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

  // 2. 优先级排序:COOP_PRIORITY 序在前(其余 +Infinity),再按价格降序;tie 保留入参顺序(JS sort 稳定)
  const prio = (id: string): number => {
    const i = COOP_PRIORITY.indexOf(id);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  const sorted = distinct.slice().sort((a, b) => {
    const pa = prio(a.id);
    const pb = prio(b.id);
    if (pa !== pb) return pa - pb;
    return (b.price ?? 0) - (a.price ?? 0);
  });

  // 3. 取前 min(n,4) 个品规,按方案 A 复制补满 4 个条单元
  const m = Math.min(sorted.length, 4);
  const unitCounts = uniformDistribute(4, m);  // 长度 m,和恒为 4
  const units: Category[] = [];
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < unitCounts[i]; k++) units.push(sorted[i]);
  }
  // units.length === 4

  // 4. 按目标柜台层数裁剪行数(常态 2 行;柜台仅 1 层时只放 1 行 = 前 2 个单元)
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
    groupCount: m,           // 展示的去重品规数(供 result chip "X 组")
  };
}
