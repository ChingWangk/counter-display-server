import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, loadImage, registerFont } from 'canvas';
import { Counter, Category } from '../types';
import { ZonePlacement, ZonePlacementGroup } from './strategies/types';
import { InlineBoxedPair } from './strategies/inlinePairs';
import { sortCategories } from './sortCategories';

// 注册中文字体:Linux 默认 fallback 字体(DejaVu/Liberation)无 CJK,
// 不注册会把 ctx.fillText 中的中文渲染为方块/乱码。逐个尝试常见路径,首个存在即注册。
// 服务器若未装字体,请运行:
//   CentOS:  yum install -y wqy-microhei-fonts && fc-cache -f
//   Ubuntu:  apt install -y fonts-wqy-microhei && fc-cache -f
// 也可通过 env CJK_FONT_PATH 显式指定字体文件路径。
const CJK_FONT_FAMILY = 'CounterCJK';
const CJK_FONT_CANDIDATES: string[] = [
  process.env.CJK_FONT_PATH || '',
  '/usr/share/fonts/wqy-microhei/wqy-microhei.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  // 本地开发兜底(macOS / Windows)
  '/System/Library/Fonts/PingFang.ttc',
  'C:/Windows/Fonts/msyh.ttc',
].filter(Boolean);

let CJK_FONT_AVAILABLE = false;
for (const fontPath of CJK_FONT_CANDIDATES) {
  if (!fs.existsSync(fontPath)) continue;
  try {
    registerFont(fontPath, { family: CJK_FONT_FAMILY });
    CJK_FONT_AVAILABLE = true;
    console.log(`[imageGen] CJK font registered: ${fontPath}`);
    break;
  } catch (err) {
    console.warn(`[imageGen] CJK font register failed: ${fontPath}`, err);
  }
}
if (!CJK_FONT_AVAILABLE) {
  console.warn('[imageGen] 未找到中文字体,陈列图上的中文将显示为方块。请安装 wqy-microhei-fonts (CentOS) 或 fonts-wqy-microhei (Ubuntu)。');
}

const FONT_FAMILY = CJK_FONT_AVAILABLE ? CJK_FONT_FAMILY : 'sans-serif';

const PACK_WIDTH_CM = 6; // 每包宽度 cm
export { PACK_WIDTH_CM };

// 每个格子的基础像素尺寸（烟包图片）
const CELL_W = 120;
const CELL_H = 160;
const PX_PER_CM = CELL_W / PACK_WIDTH_CM; // 20 px/cm

// 层板（横木）高度
const SHELF_BOARD_H = 12;
const SHELF_BOARD_COLOR = '#8B6914';
const SHELF_BOARD_SHADOW = '#6B4F10';

// 专区左侧说明标签:左侧带粗色条 + 竖排专区名,在陈列区域外侧延伸,不挤占柜台陈列容量(包数)。
const ZONE_LABEL_BAR_W = 4;       // 标签左侧粗色条宽度
const ZONE_LABEL_FONT_SIZE = 36;  // 竖排专区名字号(2026-06-10 放大两倍,原 18)
const ZONE_LABEL_LINE_H = 48;     // 竖排每字垂直占位(随字号同步放大,原 24)
const ZONE_LABEL_W = 56;          // 非爆珠专区竖排标签栏宽度(字号放大后略加宽,原 40)
// 爆珠子专区左栏(加宽):色条 + 每行一个 ≈ 烟包大小的图标(子专区跨多行则每行行首都有)+ 右侧竖排子专区名。
// 加宽只增画布左侧宽度,不缩减烟包陈列区(canvasW = labelW + displayAreaW)。
const BEAD_ICON_COL_W = CELL_W;   // 图标列宽 ≈ 烟包宽(120)
const BEAD_LABEL_TEXT_W = 44;     // 右侧竖排名文字带宽(容纳放大后的字)
const BEAD_LABEL_W = ZONE_LABEL_BAR_W + BEAD_ICON_COL_W + BEAD_LABEL_TEXT_W; // 4+120+44 = 168

// 专区行内任意两包(或两组)之间"空缝隙"的上限 = 一包烟宽度。
// 仅作用于内容固定、无法靠加排面填充的专区行(单品专区残量行 / 分组专区组间):
// 缝隙超过一包即封顶,并把多余空间退到行两侧(居中),避免出现"一包多宽"的空档。
// 规整陈列行(double/expanded/standard)不受此上限约束 —— 空隙均匀撑满整行宽、两端对齐。
const MAX_INTER_GAP_PX = CELL_W;

// 专区/专区模式常规行的"组间空隙"统一区间:下限 0.4 包、上限 1 包(= MAX_INTER_GAP_PX)。
// 「组」= 不可拆单元(升级/平替主+副、尝鲜正+反、单规格),组内不留空;组间空隙恒落此区间且整体居中。
const GAP_MIN_PX = Math.round(0.4 * CELL_W);   // 48

// 价签尺寸（贴在烟包底部）
const PRICE_TAG_H = 26;
const PRICE_TAG_FONT = `bold 16px ${FONT_FAMILY}`;
const DELISTED_STAR_COLOR = '#E8A23D'; // 退市星标(琥珀金),重点推荐区单规格标明用

// 图片输出目录（服务器上 Nginx 静态文件目录）
const OUTPUT_DIR = '/www/wwwroot/47.103.65.4/images/generated';

// 品类图片根目录
const CATEGORY_IMG_ROOT = '/www/wwwroot/47.103.65.4';

// ---- 每行布局描述 ----
// 单品专区行:specs 是扁平 Category[],每包紧贴,按 id 切换处留 gap(与常规行算法一致)
// 双包白名单(爆珠)时 specs 为「每规格连放两包」(同 id 相邻紧贴 → drawFlatRow 自然成对)。
// bgColor:整行背景色(爆珠子专区 = 该段标签色,与左侧标签栏一致);缺省不填背景。
interface ZoneSingleRowSlot {
  type: 'zone-single';
  specs: Category[];
  bgColor?: string;
}
// 分组专区行:groups 是 ZonePlacementGroup[],primary + alternatives 均单包陈列,组与组之间留 gap
interface ZoneGroupRowSlot {
  type: 'zone-group';
  groups: ZonePlacementGroup[];
}
// 工商共育条行(fixedTop):units 个「条单元」(≤2),每单元 = 1 条(5包宽) + 3 包(同规格)。
interface ZoneCartonRowSlot {
  type: 'zone-carton';
  units: Category[];
}
interface RegularRowSlot {
  type: 'regular';
  specCount: number;
}
// 尝鲜专区行(zoneRows·newProduct):每个单元 = 一个新品的「正+反」对(画幅统一);special=true 为店长推荐重点品规。
// 布局阶段(layoutNewProductZone)算好每个单元左缘 x(相对陈列区 0);drawNewProductRow 再整体偏移 areaStartX。
interface NpPlacedUnit {
  spec: Category;
  special: boolean;
  x: number;   // 左缘 x(相对陈列区起点;正面 CELL_W,反面紧跟其右)
}
interface NpRowLayout {
  units: NpPlacedUnit[];
  /** 店长推荐高亮带(仅块行有):x0/x1 相对陈列区起点,两块行同值以对齐;withThumb=底块行画👍 */
  bgBand?: { x0: number; x1: number; withThumb: boolean };
}
interface ZoneNewProductRowSlot {
  type: 'zone-newproduct';
  row: NpRowLayout;
}
type RowSlot = ZoneSingleRowSlot | ZoneGroupRowSlot | ZoneCartonRowSlot | ZoneNewProductRowSlot | RegularRowSlot;

// 常规行内单个渲染包。普通包 boxRole 缺省;内嵌配对框(产品升级/平替)的主规格 boxRole='L'、
// 副规格 boxRole='R'(L、R 在行内紧贴,被同一配对框圈住)。drawFlatRow 据此画框。
interface RenderPack {
  spec: Category;
  boxRole?: 'L' | 'R';
  boxLabel?: string;   // 配对框左上角标签:'产品升级' | '滞销平替'
  boxColor?: string;   // 配对框颜色(按专区:产品升级=红、滞销平替=绿);缺省走兜底色
  boxZoneId?: string;  // 配对所属专区('productUpgrade' | 'substitute'),置于 'L' 包,供裁"局部特写"归类
}

/**
 * 专区「局部特写」裁图:从整张陈列图裁出的一小块 PNG,供助手气泡"陈列说明"配图讲解。
 *  - 占行专区(工商共育/重点推荐/尝鲜/爆珠):一张 = 该专区整段行的局部图,只带 zoneId。
 *  - 内嵌红/绿框配对(产品升级/平替):每对一张,带 primaryId(老品/脱销)+ secondaryId(升级款/平替)。
 */
export interface ZoneCrop {
  zoneId: string;
  imageUrl: string;
  primaryId?: string;
  secondaryId?: string;
}

/** 本行画出的内嵌配对框像素区域(drawFlatRow 回收,供整图完成后裁"局部特写")。 */
interface BoxRegion {
  xLeft: number;
  xRight: number;
  baseY: number;
  zoneId?: string;
  primaryId: string;
  secondaryId: string;
}

/**
 * 无专区(新客户 / 未启用任何专区)柜台的"铺满整柜"布局参数。
 * 由 generate.ts 按归档版三档判定后传入。不传(undefined)时走专区模式:常规行顶部 cram、底部留给专区。
 */
export interface RegularFillLayout {
  /** 归档版三档布局(按品规稀疏度优化空隙):
   *   - standard:specCount ≥ 总容量。uniform 分布,每行铺满,gap≈0。
   *   - expanded:总容量/2 ≤ specCount < 总容量。单包 + staggered,空隙均匀撑满整行宽。
   *   - double:  specCount < 总容量/2。每品规 ×2 双包,staggered,同 id 紧贴。 */
  mode: 'double' | 'expanded' | 'standard';
}

// ---- 工商共育条行(fixedTop)绘制常量 ----
const CARTON_W = 5 * CELL_W;            // 条图宽 = 5 包宽 = 600px
const COOP_PACKS_PER_UNIT = 3;          // 每个条单元 = 1 条 + 3 包
const COOP_MIN_PACK_GAP = Math.round(0.12 * CELL_W);  // 3 包之间的小缝隙(偏小),≈14px

// ---- 内嵌配对框(inlineRegular:产品升级/平替)绘制常量 ----
// 配对框按专区着色以便一眼区分(工商共育是顶部条行,不画此框,故无需配色):
//   产品升级 = 红(沿用)、滞销平替 = 绿。
const INLINE_BOX_COLOR_UPGRADE = '#E63946';     // 产品升级:红(粗框醒目)
const INLINE_BOX_COLOR_SUBSTITUTE = '#2E7D32';  // 滞销平替:森林绿(粗框醒目)
const INLINE_BOX_COLOR_DEFAULT = '#E63946';     // 兜底红(理论上每对都带专区色,不会落到此值)
const INLINE_BOX_LINE_W = 6;          // 框线粗细(明显)
const INLINE_BOX_TAB_H = 22;          // 左上角标签条高度

/** 内嵌配对框专区 → 框色:产品升级=红、滞销平替=绿。 */
function inlineBoxColor(zoneId: InlineBoxedPair['zoneId']): string {
  return zoneId === 'substitute' ? INLINE_BOX_COLOR_SUBSTITUTE : INLINE_BOX_COLOR_UPGRADE;
}

// ---- 尝鲜专区(newProduct)正反面 + 店长推荐重点品规绘制常量 ----
// ---- 尝鲜专区(newProduct)店长推荐绘制常量(画幅统一,靠间隙+背景+👍 凸显,不拉宽烟包)----
const NP_UNIT_W = 2 * CELL_W;                  // 尝鲜单元 = 正+反两包(统一画幅)
const MANAGER_PICK_BG = '#F0B429';             // 店长推荐高亮背景(深金,显著)
const MANAGER_PICK_BG_BORDER = '#B8860B';      // 高亮背景描边(暗金)
const MANAGER_PICK_PAD = Math.round(0.3 * CELL_W);   // 高亮带相对块矩形左右外扩 ~36
const MANAGER_THUMB_PATH = '/images/decor/thumb.png'; // 大拇指资产(缺图走矢量兜底 drawVectorThumb)

// 同一专区跨 rowCount 行的合并标签信息:左侧画一条贯穿全部行的竖向 label
interface ZoneLabelBlock {
  startRow: number;  // 在最终行网格中的绝对起始行 index (0-based)
  rowCount: number;
  label: string;
  barColor: string;
  iconImage?: string;  // 段顶小图标贴图(爆珠子专区用;缺图画 barColor 色块占位)
}

/** 底部专区每段的左侧标签信息。爆珠按子专区产多条(各带 iconImage);其它专区每 zone 一条。 */
interface BottomLabelInfo {
  rows: number;
  label: string;
  barColor: string;
  iconImage?: string;
}

/**
 * 绘制"未收录"占位图：灰底 + 商品名前三字 + "未收录"
 */
function drawPlaceholder(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  ctx.fillStyle = '#E0D8CC';
  ctx.fillRect(x, y, w, h);

  const label = name.slice(0, 3) + '\n未收录';
  const lines = label.split('\n');
  ctx.fillStyle = '#888';
  ctx.font = `bold 18px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = 24;
  const startY = y + h / 2 - ((lines.length - 1) * lineH) / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x + w / 2, startY + i * lineH);
  }
}

/**
 * 绘制价签：贴在烟包底部的白底蓝字"¥XX.X"小标签。
 * 仅当 spec_id 命中 priceTagMap 时调用,用于直接展示售价 < 杨浦区均价的规格。
 */
function drawPriceTag(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  price: number,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const tagY = y + h - PRICE_TAG_H;
  // 白底
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(x, tagY, w, PRICE_TAG_H);
  // 蓝色边框,1 px(与字色一致)
  ctx.strokeStyle = '#1565C0';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, tagY + 0.5, w - 1, PRICE_TAG_H - 1);
  // 蓝字
  ctx.fillStyle = '#1565C0';
  ctx.font = PRICE_TAG_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`¥${price.toFixed(1)}`, x + w / 2, tagY + PRICE_TAG_H / 2);
}

/**
 * 绘制退市星标:贴在烟包左上角的白底琥珀边 ★ 小标(形式同价签 drawPriceTag)。
 * 仅重点推荐区的退市规格(is_delisted)单规格陈列时调用,特殊标明"退市经典"。
 */
function drawDelistedStar(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  x: number,
  y: number,
  size: number,
): void {
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = DELISTED_STAR_COLOR;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  ctx.fillStyle = DELISTED_STAR_COLOR;
  ctx.font = `bold ${size - 6}px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('★', x + size / 2, y + size / 2 + 1);
}

/**
 * 均匀分布：将 total 个规格均匀分配到 rows 行
 * 多出的放在前面的行（视觉上顶部更满）
 */
function uniformDistribute(total: number, rows: number): number[] {
  if (rows <= 0) return [];
  const base = Math.floor(total / rows);
  const extra = total % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * 交错分布：将 total 个规格分配到 rows 行
 * 把"多余"的行均匀散布，避免在两端集中，形成砖墙错位视觉
 */
function staggeredDistribute(total: number, rows: number): number[] {
  if (rows <= 0) return [];
  const base = Math.floor(total / rows);
  const extra = total % rows;
  const result: number[] = new Array(rows).fill(base);

  if (extra === 0) return result;

  for (let i = 0; i < extra; i++) {
    const idx = Math.min(Math.floor((i + 0.5) * rows / extra), rows - 1);
    result[idx]++;
  }

  return result;
}

/**
 * 一行最多能放几个等宽单元,使组间空隙仍 ≥ GAP_MIN_PX:
 * k 个单元 + (k-1) 个 ≥GAP_MIN 空隙 ≤ areaW ⇒ k ≤ (areaW + GAP_MIN)/(unitW + GAP_MIN)。
 */
function maxUnitsPerRow(areaW: number, unitW: number): number {
  if (unitW <= 0) return 0;
  return Math.max(0, Math.floor((areaW + GAP_MIN_PX) / (unitW + GAP_MIN_PX)));
}

/**
 * 双包白名单(§8.3.4,2026-06-08 重启):列入的专区按「每规格两包紧贴」促销陈列。
 * 当前仅爆珠(zone-single 经 planBeadSubzoneRows)。移出本集合即恢复单包。
 */
const DOUBLE_PACK_ZONES = new Set<string>(['beadFlavor']);

/**
 * 爆珠子专区分段排版:把 zone.rowCount 行按各子专区(subZones)的规格数比例分配(每段 ≥1 行),
 * 每段内规格 uniformDistribute 到该段行;**双包白名单**内每规格放两包紧贴(promotion 视觉),
 * 并给每行打上该子专区标签色作整行背景(与左侧标签栏一致)。产出每段一条带 iconImage 的左侧标签。
 *
 * groups 已是「子专区有序」序列(buildZonePlacements 保证),subZones[i].count 即各段规格数。
 * 兜底:行数 < 非空段数时,只渲染前 rowCount 段(各 1 行),其余段规格并入最后一段(cram),并 warn。
 * 返回的 slots 行数恰为 zone.rowCount(与 generate.ts 预留一致)。
 */
function planBeadSubzoneRows(
  zone: ZonePlacement,
  displayAreaW: number,
): { slots: ZoneSingleRowSlot[]; labels: BottomLabelInfo[] } {
  const flat = zone.groups.map(g => g.primary);
  const doublePack = DOUBLE_PACK_ZONES.has(zone.zoneId);
  const unitW = doublePack ? 2 * CELL_W : CELL_W;          // 双包 = 每规格占 2 格
  const cap = Math.max(1, maxUnitsPerRow(displayAreaW, unitW)); // 每行最多放几个规格(双包按对算)
  const R = Math.max(1, zone.rowCount);
  let segs = (zone.subZones ?? []).filter(s => s.count > 0);
  if (segs.length === 0) segs = [{ id: 'all', label: zone.label, iconImage: '', barColor: zone.barColor, count: flat.length }];

  // 行数不足以每段 1 行:保留前 R-1 段,其余并入第 R 段(用其首段的 label/icon)。
  if (R < segs.length) {
    console.warn(`[beadFlavor] 行数不足:${R} 行 < ${segs.length} 子专区,后 ${segs.length - R + 1} 段并入第 ${R} 段`);
    const head = segs.slice(0, R - 1);
    const tail = segs.slice(R - 1);
    const tailCount = tail.reduce((s, z) => s + z.count, 0);
    segs = [...head, { ...tail[0], count: tailCount }];
  }

  // 按规格数比例分行,每段 ≥1,修正总和到 R(多退少补,优先动规格数最多的段)。
  const totalSpecs = segs.reduce((s, z) => s + z.count, 0) || 1;
  const rowsForSub = segs.map(z => Math.max(1, Math.round((R * z.count) / totalSpecs)));
  const orderByCount = segs.map((_, i) => i).sort((a, b) => segs[b].count - segs[a].count);
  let diff = R - rowsForSub.reduce((a, b) => a + b, 0);
  while (diff !== 0) {
    let moved = false;
    for (const i of orderByCount) {
      if (diff === 0) break;
      if (diff > 0) { rowsForSub[i] += 1; diff--; moved = true; }
      else if (rowsForSub[i] > 1) { rowsForSub[i] -= 1; diff++; moved = true; }
    }
    if (!moved) break;  // 全为 1 且仍需减(R<段数,已被上面兜底,不应到此)
  }

  const slots: ZoneSingleRowSlot[] = [];
  const labels: BottomLabelInfo[] = [];
  let off = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const rows = rowsForSub[i];
    const segSpecs = flat.slice(off, off + seg.count);
    off += seg.count;
    // perRow:每行放几个规格(双包时每规格 = 一对);take 封顶 cap,尾部超出 cram 丢弃。
    const perRow = uniformDistribute(Math.min(segSpecs.length, cap * rows), rows);
    let so = 0;
    for (let r = 0; r < rows; r++) {
      const take = Math.min(perRow[r], cap);
      const rowSpecs = segSpecs.slice(so, so + take);
      so += take;
      // 双包:每规格连放两包(同 id 相邻 → drawFlatRow 自然成对、对间留 [0.4,1] 包空隙)。
      const packs = doublePack ? rowSpecs.flatMap(s => [s, s]) : rowSpecs;
      slots.push({ type: 'zone-single', specs: packs, bgColor: seg.barColor });
    }
    labels.push({ rows, label: seg.label, barColor: seg.barColor, iconImage: seg.iconImage });
  }
  return { slots, labels };
}

/**
 * 把若干单元放进 [areaStartX, areaStartX + areaW]:组间空隙 = clamp(余量/间隔数, GAP_MIN_PX, MAX_INTER_GAP_PX),
 * 整体居中(余量退两侧)。返回每个单元的左缘 x。
 * 防溢出:单元过密(连 GAP_MIN 都放不下)时,放宽空隙到 < GAP_MIN(直至 0)以**避免画出界外**;
 * 且左缘恒 ≥ areaStartX。调用方仍应把单元数控制在 maxUnitsPerRow 内,以保证空隙 ≥ GAP_MIN 的观感。
 */
function placeUnitsClamped(unitWidths: number[], areaStartX: number, areaW: number): number[] {
  const n = unitWidths.length;
  if (n === 0) return [];
  const totalW = unitWidths.reduce((s, w) => s + w, 0);
  const nGaps = n - 1;
  let gap = 0;
  if (nGaps > 0) {
    const fit = (areaW - totalW) / nGaps;          // 恰好填满整行宽的空隙
    gap = fit >= GAP_MIN_PX ? Math.min(fit, MAX_INTER_GAP_PX) : Math.max(0, fit);  // 过密则放宽,不强行 MIN
  }
  const contentW = totalW + nGaps * gap;
  let x = areaStartX + (areaW - contentW) / 2;       // 居中
  if (x < areaStartX) x = areaStartX;                // 防左溢出(content > areaW 时左对齐)
  const xs: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = x;
    x += unitWidths[i] + gap;
  }
  return xs;
}

/**
 * 构造常规区渲染包列表:把内嵌红框配对(产品升级/平替)的副规格插到主规格右侧,
 * 主+副成对不翻倍;double 模式普通包翻倍为两包;副规格若在序列别处出现则去重移除。
 *
 * - inlinePairs: Map<主规格 id, 配对>(generate.ts computeInlinePairs 产出,全局传入,
 *   本函数仅对本柜 regularSpecs 内出现的主规格生效)
 * - doubleMode:  归档版 double 档(稀疏)——普通包翻倍紧贴,红框配对始终单对不翻倍
 * 主规格在本柜重复出现时只在首次配成红框,其余次作普通包。
 * 副规格若原本排在主规格之前,则被前移到主规格右侧(去重移动,不重复画两次)。
 */
function buildRegularRenderPacks(
  regularSpecs: Category[],
  inlinePairs: ReadonlyMap<string, InlineBoxedPair> | undefined,
  doubleMode: boolean,
): RenderPack[] {
  const out: RenderPack[] = [];
  if (!inlinePairs || inlinePairs.size === 0) {
    for (const s of regularSpecs) {
      out.push({ spec: s });
      if (doubleMode) out.push({ spec: s });
    }
    return out;
  }
  // 本柜出现的主规格 → 其副规格 id(用于把副规格的其它自然出现去重移除)
  const secondaryIdsToRemove = new Set<string>();
  const seen = new Set<string>();
  for (const s of regularSpecs) {
    if (inlinePairs.has(s.id) && !seen.has(s.id)) {
      seen.add(s.id);
      secondaryIdsToRemove.add(inlinePairs.get(s.id)!.secondary.id);
    }
  }
  const pairedDone = new Set<string>();
  for (const s of regularSpecs) {
    const pair = inlinePairs.get(s.id);
    if (pair && !pairedDone.has(s.id)) {
      pairedDone.add(s.id);
      const boxColor = inlineBoxColor(pair.zoneId);
      out.push({ spec: s, boxRole: 'L', boxLabel: pair.boxLabel, boxColor, boxZoneId: pair.zoneId });
      out.push({ spec: pair.secondary, boxRole: 'R', boxLabel: pair.boxLabel, boxColor });
      continue;
    }
    if (secondaryIdsToRemove.has(s.id)) continue;  // 该副规格已随主规格插入,跳过其它出现
    out.push({ spec: s });
    if (doubleMode) out.push({ spec: s });
  }
  return out;
}

/** 渲染包超出行容量时按顺序裁到 capacity:红框配对原子保留(整对或不要),普通包按序填充。 */
function trimToCapacity(packs: RenderPack[], capacity: number): RenderPack[] {
  if (packs.length <= capacity) return packs;
  const cap = Math.max(0, capacity);
  const out: RenderPack[] = [];
  for (let i = 0; i < packs.length; i++) {
    const p = packs[i];
    if (p.boxRole === 'L' && i + 1 < packs.length && packs[i + 1].boxRole === 'R') {
      if (out.length + 2 <= cap) out.push(p, packs[i + 1]);
      i++;  // 跳过 R(整对处理)
      continue;
    }
    if (out.length + 1 <= cap) out.push(p);
  }
  return out;
}

/**
 * 含红框配对时的每行包数重排:在「不超过行宽 cap、不拆开红框配对(2 格须同行)」前提下,
 * 尽量贴合 idealPerRow 的分布(standard=uniform 铺满 / 其余=staggered 错位)。
 *
 * 逐包放入当前行(普通包占 1 格、配对占 2 格):本行已达 ideal 目标 → 换行(维持分布形态);
 * 本行 + need 超 cap → 换行(防顶破行宽 / 防拆对)。行数用尽后尾部未放下的包丢弃
 * (与既有 cram 行为一致,丢的是低优先级尾包)。无配对时调用方直接用 idealPerRow,不经此函数。
 */
function distributePairAware(packs: RenderPack[], idealPerRow: number[], cap: number): number[] {
  const rows = idealPerRow.length;
  const counts = new Array(rows).fill(0);
  if (rows <= 0 || cap <= 0) return counts;
  let r = 0;
  let i = 0;
  while (i < packs.length && r < rows) {
    const isPair = packs[i].boxRole === 'L' && i + 1 < packs.length && packs[i + 1].boxRole === 'R';
    const need = isPair ? 2 : 1;
    const fitsCap = counts[r] + need <= cap;
    const reachedIdeal = counts[r] >= idealPerRow[r];
    if (fitsCap && !reachedIdeal) {
      counts[r] += need;
      i += need;
    } else {
      r++;  // 本行已达目标 / 放不下 → 换行
    }
  }
  return counts;
}

/**
 * 为单个柜台生成陈列图片
 *
 * 整张画布:左侧 labelW 宽的"专区标签栏"(仅当本柜台有专区行时才预留,否则 labelW=0) +
 * 右侧陈列区域(width = counter.length × PX_PER_CM)。标签栏不挤占陈列容量(包数),仅在画布
 * 外侧延伸。无专区的柜台(新客户 / 未启用专区)labelW=0,陈列区贴画布左缘,左侧无空白预留位。
 *
 * 行布局自上而下:
 *   [顶部] fixedTop 条行(工商共育):每行 条+3包+条+3包,固定在柜台最顶,把常规行整体下移
 *   [中部] 常规陈列:无专区走三档 double/expanded/standard(行内空隙撑满整行宽);专区模式均匀分布 +
 *          组间空隙钳到 [0.4,1] 包、居中(placeUnitsClamped)
 *   [底部] 其余功能专区(左侧标签栏画专区名,同专区跨多行合并为一条):
 *     - 尝鲜(newProduct):每品正反面对,店长推荐 2×2 居中高亮背景带 + 👍,其余 tier 降序均匀环绕
 *     - 爆珠(beadFlavor):单品均匀分布
 *     - 重点推荐(keyRecommend):退市★ / 滞销单品,均匀分布;组间空隙 [0.4,1] 包、居中
 *   [最下] 空闲层(仅画层板,不放品规)
 *
 * 顶部 fixedTop 与底部专区各自按出现顺序展开;底部多个 zone 按 (priorityRank ASC, groupCount DESC) 排序,
 * 每个占用 rowCount 行(已含 autoExpand)。
 *
 * @param regularRows 常规陈列实际占用的行数(由 generate 分配后确定,已扣除 fixedTop 行)
 * @param zonePlacements 本柜台的专区落位(rowCount 已经过 autoExpand 扩展;含 fixedTop 工商共育条行)
 * @param priceTagMap spec_id → avg_price 映射;命中时在烟包底部画价签;缺省/空时不画
 * @param regularLayout 无专区柜台的"铺满整柜"布局(归档版三档 standard/expanded/double);
 *                      传入时常规行铺满 regularRows 行:double 把每品规翻倍为两包后
 *                      staggered 分布,expanded 单包 staggered,standard 单包 uniform;行内空隙由
 *                      drawFlatRow 均匀撑满整行宽、两端对齐。不传则走专区模式(常规顶部 cram + staggered 单包)。
 * @param inlinePairs Map<主规格 id, 内嵌红框配对>(产品升级/平替)。本柜常规序列中出现的主规格,
 *                    其右侧紧跟一个副规格并被粗红框圈住;副规格在序列别处的自然出现会被去重移除。
 */
export async function generateCounterImage(
  counter: Counter,
  regularSpecs: Category[],
  regularRows: number,
  zonePlacements?: ZonePlacement[],
  priceTagMap?: ReadonlyMap<string, number>,
  regularLayout?: RegularFillLayout,
  inlinePairs?: ReadonlyMap<string, InlineBoxedPair>,
): Promise<{ imageUrl: string; usedCount: number; crops: ZoneCrop[] }> {
  const displayAreaW = Math.round(counter.length * PX_PER_CM);
  const levels = counter.levels;

  // 局部特写裁图的收集容器:
  //  - boxRegions:内嵌红/绿框配对的像素区域(drawFlatRow 回收),整图画完后每对裁一张。
  //  - zoneBands:占行专区(工商共育/重点推荐/尝鲜/爆珠)各自占用的行区间,整图画完后每段裁一张。
  const boxRegions: BoxRegion[] = [];
  const zoneBands: { zoneId: string; startRow: number; rows: number }[] = [];

  if (displayAreaW <= 0 || levels <= 0) {
    throw new Error(`柜台 ${counter.id} 参数无效: length=${counter.length}, levels=${counter.levels}`);
  }

  const singleMaxPerRow = Math.floor(counter.length / PACK_WIDTH_CM);

  // ---- 1. 计算常规行布局 ----
  const clampedRegularRows = Math.max(0, Math.min(regularRows, levels));
  const rowCapacity = singleMaxPerRow * clampedRegularRows;  // 常规区可容纳的总包数上限
  let regularRowLayouts: RegularRowSlot[];
  // 常规渲染包列表(含内嵌红框配对):RenderPack 携带 boxRole/boxLabel,供 drawFlatRow 画红框。
  let placedRegular: RenderPack[] = [];
  if (clampedRegularRows === 0 || regularSpecs.length === 0) {
    regularRowLayouts = [];
  } else {
    // 三档(double/expanded/standard,见 RegularFillLayout)与专区模式共用:先构造渲染包再分布。
    //  - double:  普通包翻倍(同 id 紧贴),红框配对不翻倍;staggered 分布
    //  - expanded:单包;staggered 分布(空隙由 drawFlatRow 均匀撑满整行宽)
    //  - standard:单包;uniform 分布(每行铺满,gap≈0)
    //  - 专区模式(无 regularLayout):常规顶部 cram,staggered 分布,余量留给底部专区
    const doubleMode = !!regularLayout && regularLayout.mode === 'double';
    let renderPacks = buildRegularRenderPacks(regularSpecs, inlinePairs, doubleMode);
    // 容量封顶:超出行容量则从尾部裁(红框配对优先保留、绝不拆对);专区模式同样在此 cram。
    if (renderPacks.length > rowCapacity) renderPacks = trimToCapacity(renderPacks, rowCapacity);
    // 先按 mode 算"理想每行包数"(standard=uniform 铺满,其余=staggered 错位);含红框配对时
    // 再用 distributePairAware 重排:不超行宽、不拆对前提下尽量贴合理想分布。无配对则直接用理想分布。
    // 无专区三档:standard=uniform 铺满 / expanded·double=staggered 错位;专区模式:uniform 均匀(每行规格数均匀)
    const idealDistribute = regularLayout
      ? (regularLayout.mode === 'standard' ? uniformDistribute : staggeredDistribute)
      : uniformDistribute;
    const idealPerRow = idealDistribute(renderPacks.length, clampedRegularRows);
    const hasPairs = renderPacks.some(p => p.boxRole !== undefined);
    const perRow = hasPairs
      ? distributePairAware(renderPacks, idealPerRow, singleMaxPerRow)
      : idealPerRow;
    regularRowLayouts = perRow.map(n => ({ type: 'regular' as const, specCount: n }));
    placedRegular = renderPacks;
  }

  // ---- 2. 拆分专区:fixedTop(工商共育条行,固定在柜台最顶) vs 其余(常规之下的底部专区) ----
  const allZones = (zonePlacements ?? []).slice();
  const topZonePlacements = allZones.filter(z => z.layoutKind === 'fixedTop');
  // inlineRegular(产品升级/平替)不占行——由常规行内红框渲染,这里排除,避免误当占行专区
  const bottomZonePlacements = allZones
    .filter(z => z.layoutKind !== 'fixedTop' && z.layoutKind !== 'inlineRegular')
    .sort((a, b) => a.priorityRank - b.priorityRank || b.groupCount - a.groupCount);

  // 2a. 顶部 fixedTop 条行:每个 placement 的 groups(条单元)按 2 个/行切块为 zone-carton 行
  const topRowSlots: ZoneCartonRowSlot[] = [];
  const topLabelInfo: { rows: number; label: string; barColor: string }[] = [];
  for (const zone of topZonePlacements) {
    const units = zone.groups.map(g => g.primary);
    const rows = Math.max(0, Math.min(zone.rowCount, levels));
    const bandStart = topRowSlots.length;  // 顶部条行从 row 0 起连续填充,已填数即本段绝对起始行
    for (let r = 0; r < rows; r++) {
      topRowSlots.push({ type: 'zone-carton', units: units.slice(r * 2, r * 2 + 2) });
    }
    if (rows > 0) {
      topLabelInfo.push({ rows, label: zone.label, barColor: zone.barColor });
      zoneBands.push({ zoneId: zone.zoneId, startRow: bandStart, rows });
    }
  }

  // 2b. 底部专区行:单品 staggered / 分组 bin-packing(逻辑同归档)
  const bottomRowSlots: (ZoneSingleRowSlot | ZoneGroupRowSlot | ZoneNewProductRowSlot)[] = [];
  const bottomLabelInfo: BottomLabelInfo[] = [];
  // 底部专区各自占用的行区间(相对 bottomStartRow),整图画完后每段裁一张"局部特写"。
  const bottomBands: { zoneId: string; relStart: number; rows: number }[] = [];
  for (const zone of bottomZonePlacements) {
    const before = bottomRowSlots.length;
    // 爆珠:按子专区(subZones)分段渲染,每段一条左侧标签(分段竖标 + 段图标)。自带标签,处理完即跳过末尾通用 push。
    if (zone.zoneId === 'beadFlavor' && zone.subZones && zone.subZones.length > 0) {
      const plan = planBeadSubzoneRows(zone, displayAreaW);
      for (const s of plan.slots) bottomRowSlots.push(s);
      for (const l of plan.labels) bottomLabelInfo.push(l);
      bottomBands.push({ zoneId: zone.zoneId, relStart: before, rows: bottomRowSlots.length - before });
      continue;
    }
    if (zone.zoneId === 'newProduct') {
      // 尝鲜专区:正反面 + 店长推荐 2×2 居中高亮(详见 layoutNewProductZone)。
      // 返回恰好 zone.rowCount 行,每行一个 NpRowLayout(含显式坐标 + 块行高亮带;可能空行占位)。
      const npRows = layoutNewProductZone(zone, displayAreaW);
      for (const row of npRows) bottomRowSlots.push({ type: 'zone-newproduct', row });
    } else if (zone.displayMode === 'single') {
      // 单品专区(爆珠口味组合等):拉平 groups 为 primary 列表,单包陈列。
      // 每行封顶 maxUnitsPerRow(GAP_MIN 下能放下的数),保证组间空隙 ≥ 0.4 包且不画出界外。
      // 注:newProduct 已在上面的专属分支处理(正反面 + 店长推荐),不再经此。
      const flatSpecs = zone.groups.map(g => g.primary);
      const cap = maxUnitsPerRow(displayAreaW, CELL_W);
      const perRow = uniformDistribute(Math.min(flatSpecs.length, cap * zone.rowCount), zone.rowCount);
      let off = 0;
      for (let r = 0; r < zone.rowCount; r++) {
        const take = Math.min(perRow[r], cap);
        bottomRowSlots.push({ type: 'zone-single', specs: flatSpecs.slice(off, off + take) });
        off += take;
      }
    } else {
      // 分组专区(重点推荐区):每组(退市★/滞销均为单包,宽 = (1+alts)·CELL_W)按 uniformDistribute
      // 均匀分到 rowCount 行(杜绝"前几行塞满末行空"),每行封顶 maxUnitsPerRow 防画出界外;
      // 行内由 drawGroupedZoneRow 用 placeUnitsClamped 钳制组间空隙 [0.4,1] 包、居中。
      const groups = zone.groups.filter(g => (1 + g.alternatives.length) * CELL_W <= displayAreaW);
      const cap = maxUnitsPerRow(displayAreaW, CELL_W);
      const perRow = uniformDistribute(Math.min(groups.length, cap * zone.rowCount), zone.rowCount);
      let off = 0;
      for (let r = 0; r < zone.rowCount; r++) {
        const take = Math.min(perRow[r], cap);
        bottomRowSlots.push({ type: 'zone-group', groups: groups.slice(off, off + take) });
        off += take;
      }
    }
    bottomLabelInfo.push({ rows: bottomRowSlots.length - before, label: zone.label, barColor: zone.barColor });
    bottomBands.push({ zoneId: zone.zoneId, relStart: before, rows: bottomRowSlots.length - before });
  }

  // ---- 3. 行槽装配:顶部条行 → 常规 → 底部专区 → 空闲(slot 为 undefined) ----
  const rowSlots: (RowSlot | undefined)[] = new Array(levels).fill(undefined);
  let fillRow = 0;
  for (const s of topRowSlots) { if (fillRow < levels) rowSlots[fillRow++] = s; }
  for (let i = 0; i < regularRowLayouts.length && fillRow < levels; i++) rowSlots[fillRow++] = regularRowLayouts[i];
  const bottomStartRow = fillRow;
  for (let i = 0; i < bottomRowSlots.length && fillRow < levels; i++) rowSlots[fillRow++] = bottomRowSlots[i];
  // 底部专区行段转绝对行号(用于裁"局部特写")
  for (const b of bottomBands) {
    zoneBands.push({ zoneId: b.zoneId, startRow: bottomStartRow + b.relStart, rows: b.rows });
  }

  // 标签块(绝对起始行):顶部从 0 累加,底部从 bottomStartRow 累加
  const zoneLabelBlocks: ZoneLabelBlock[] = [];
  let topCursor = 0;
  for (const info of topLabelInfo) {
    zoneLabelBlocks.push({ startRow: topCursor, rowCount: info.rows, label: info.label, barColor: info.barColor });
    topCursor += info.rows;
  }
  let bottomCursor = bottomStartRow;
  for (const info of bottomLabelInfo) {
    zoneLabelBlocks.push({ startRow: bottomCursor, rowCount: info.rows, label: info.label, barColor: info.barColor, iconImage: info.iconImage });
    bottomCursor += info.rows;
  }

  // 左侧专区标签栏仅在本柜台确有专区行(顶部条行或底部专区)时才预留宽度;否则 labelW=0,陈列区贴左缘。
  // 左侧专区标签栏宽度:含爆珠子专区(带 iconImage,每行画 ≈ 烟包大图标)→ 加宽到 BEAD_LABEL_W;
  // 其它专区 → ZONE_LABEL_W;本柜台无任何专区行 → 0(陈列区贴左缘)。加宽只增左侧留白,不缩减烟包区。
  const hasBeadIconLabel = zoneLabelBlocks.some(b => !!b.iconImage);
  const labelW = (topRowSlots.length > 0 || bottomRowSlots.length > 0)
    ? (hasBeadIconLabel ? BEAD_LABEL_W : ZONE_LABEL_W)
    : 0;

  // ---- 实际使用的 regular 包数(含内嵌副规格;double 模式普通包已翻倍)----
  const usedCount = regularRowLayouts.reduce((s, r) => s + r.specCount, 0);

  // ---- 画布尺寸 ----
  const shelfBoards = levels - 1;
  const PADDING_TOP = 2;
  const canvasH = levels * CELL_H + shelfBoards * SHELF_BOARD_H + PADDING_TOP * 2;
  const canvasW = labelW + displayAreaW;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  // 背景色
  ctx.fillStyle = '#F5F0E8';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // ---- 逐行绘制品规 ----
  // 常规 / 单品专区:同 id 紧贴,按 id 切换处加 gap
  // 分组专区:组内紧贴(primary + alts 均单包),组与组之间加 gap
  // 所有绘制都偏移 ZONE_LABEL_W,把陈列区域限制在 [ZONE_LABEL_W, canvasW] 内
  let regularIdx = 0;
  for (let row = 0; row < levels; row++) {
    const slot = rowSlots[row];
    if (!slot) continue;

    const baseY = PADDING_TOP + row * (CELL_H + SHELF_BOARD_H);

    if (slot.type === 'zone-carton') {
      // 工商共育条行:条+3包+条+3包,不画价签(政策曝光位)
      await drawIndustrialCoopRow(ctx, slot.units, labelW, displayAreaW, baseY);
      continue;
    }

    if (slot.type === 'zone-group') {
      await drawGroupedZoneRow(ctx, slot.groups, labelW, displayAreaW, baseY, priceTagMap);
      continue;
    }

    if (slot.type === 'zone-newproduct') {
      // 尝鲜专区行:正反面 + 店长推荐 2×2 居中(高亮背景带 + 👍)
      await drawNewProductRow(ctx, slot.row, labelW, baseY, priceTagMap);
      continue;
    }

    let rowPacks: RenderPack[];
    let capGap = false;
    if (slot.type === 'zone-single') {
      // 爆珠子专区:先把整行背景填成该段标签色(与左侧标签栏一致),再在其上画包。
      if (slot.bgColor) {
        ctx.fillStyle = slot.bgColor;
        ctx.fillRect(labelW, baseY, displayAreaW, CELL_H);
      }
      // 单品专区残量行:内容固定不可加排面,空隙超一包即封顶并整行居中(capGap=true)
      rowPacks = slot.specs.map(s => ({ spec: s }));
      capGap = true;
    } else {
      // 规整陈列行:placedRegular 含内嵌红框配对(RenderPack 带 boxRole),drawFlatRow 据此画红框。
      //  - 专区模式(regularLayout 缺省):capGap=true → 组间空隙钳到 [0.4,1] 包、居中(跨柜密度一致)
      //  - 无专区三档(有 regularLayout):capGap=false → 空隙均匀撑满整行宽、两端对齐(铺满整柜)
      rowPacks = placedRegular.slice(regularIdx, regularIdx + slot.specCount);
      regularIdx += slot.specCount;
      capGap = regularLayout === undefined;
    }
    if (rowPacks.length === 0) continue;

    await drawFlatRow(ctx, rowPacks, labelW, displayAreaW, baseY, priceTagMap, capGap, boxRegions);
  }

  // ---- 绘制层板(横贯整个画布,后续 zone label 会覆盖其在 label 栏内的部分) ----
  for (let r = 0; r < shelfBoards; r++) {
    const boardY = PADDING_TOP + (r + 1) * CELL_H + r * SHELF_BOARD_H;
    ctx.fillStyle = SHELF_BOARD_COLOR;
    ctx.fillRect(0, boardY, canvasW, SHELF_BOARD_H);
    ctx.fillStyle = SHELF_BOARD_SHADOW;
    ctx.fillRect(0, boardY + SHELF_BOARD_H - 2, canvasW, 2);
  }

  // ---- 绘制专区左侧说明标签(同专区跨 rowCount 行合并为一条,覆盖层板穿过 label 栏的部分) ----
  for (const block of zoneLabelBlocks) {
    const topRow = block.startRow;
    if (topRow >= levels) continue;
    const bottomRow = Math.min(topRow + block.rowCount - 1, levels - 1);
    const startY = PADDING_TOP + topRow * (CELL_H + SHELF_BOARD_H);
    const endY = PADDING_TOP + bottomRow * (CELL_H + SHELF_BOARD_H) + CELL_H;
    const visibleRows = bottomRow - topRow + 1;  // 爆珠按此行数逐行画图标
    await drawZoneLabel(ctx, 0, startY, labelW, endY - startY, block.label, block.barColor, block.iconImage, visibleRows);
  }

  // ---- 输出文件 ----
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const filename = `counter_${counter.id}_${Date.now()}.png`;
  const outputPath = path.join(OUTPUT_DIR, filename);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);

  // ---- 裁「局部特写」小图:占行专区各一张(整段行,含左侧专区标签) + 内嵌红/绿框每对一张 ----
  // 从已合成的整图 canvas 上裁,保证局部与整图完全一致(含红/绿框、★、店长推荐金底等标记)。
  const crops: ZoneCrop[] = [];
  let cropSeq = 0;
  const CROP_PAD = 12;                 // 配对裁图四周留白(像素)
  const MAX_PAIR_CROPS_PER_ZONE = 6;   // 每个 inline 专区最多裁几对(与前端讲解条数上限一致,避免小图过多)

  for (const b of zoneBands) {
    if (b.rows <= 0 || b.startRow >= levels) continue;
    const topR = b.startRow;
    const botR = Math.min(topR + b.rows - 1, levels - 1);
    const sy = PADDING_TOP + topR * (CELL_H + SHELF_BOARD_H);
    const ey = PADDING_TOP + botR * (CELL_H + SHELF_BOARD_H) + CELL_H;
    crops.push(writeZoneCrop(canvas, 0, sy, canvasW, ey - sy, counter.id, b.zoneId, cropSeq++));
  }

  const pairCountByZone = new Map<string, number>();
  for (const r of boxRegions) {
    const zkey = r.zoneId || 'inline';
    const n = pairCountByZone.get(zkey) || 0;
    if (n >= MAX_PAIR_CROPS_PER_ZONE) continue;
    pairCountByZone.set(zkey, n + 1);
    const sx = Math.max(0, r.xLeft - CROP_PAD);
    const cy = Math.max(0, r.baseY - CROP_PAD);
    const ex = Math.min(canvasW, r.xRight + CROP_PAD);
    const ey = Math.min(canvasH, r.baseY + CELL_H + CROP_PAD);
    crops.push(writeZoneCrop(canvas, sx, cy, ex - sx, ey - cy, counter.id, zkey, cropSeq++, r.primaryId, r.secondaryId));
  }

  return { imageUrl: `/images/generated/${filename}`, usedCount, crops };
}

/**
 * 从整图 src 裁出 [sx,sy,sw,sh] 区域,写为独立 PNG 到 OUTPUT_DIR,返回 ZoneCrop。
 * 供生成专区/配对的「局部特写」小图(助手气泡"陈列说明"配图)。
 */
function writeZoneCrop(
  src: ReturnType<typeof createCanvas>,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  counterId: string,
  zoneId: string,
  seq: number,
  primaryId?: string,
  secondaryId?: string,
): ZoneCrop {
  const w = Math.max(1, Math.round(sw));
  const h = Math.max(1, Math.round(sh));
  const crop = createCanvas(w, h);
  const cctx = crop.getContext('2d');
  cctx.drawImage(src, Math.round(sx), Math.round(sy), w, h, 0, 0, w, h);
  const filename = `crop_${counterId}_${zoneId}_${seq}_${Date.now()}.png`;
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), crop.toBuffer('image/png'));
  return { zoneId, imageUrl: `/images/generated/${filename}`, primaryId, secondaryId };
}

/**
 * 绘制扁平行(常规 + 单品专区):同组键紧贴,组键切换处加 gap,gap 由本行剩余宽度均分。
 * 烟包绘制于 [areaStartX, areaStartX + areaW] 区间内,左侧 areaStartX 留给专区标签栏。
 *
 * 内嵌红框配对(RenderPack.boxRole):主规格'L'与副规格'R'同组键(紧贴、无内部 gap),
 * 红框两侧按普通组键切换留 gap;画完本行烟包后,按像素位置在每对 L/R 上叠加粗红框 + 标签。
 *
 * @param capGap 是否对超限空隙封顶并整行居中:
 *   - false(规整陈列行):空隙均匀撑满整行宽、两端对齐(double/expanded 的"扩大间距"语义)。
 *     包列表与稀疏度已由 generateCounterImage 的三档逻辑(double 翻倍 / 单包)在上游决定。
 *   - true(单品专区残量行):内容固定不可加排面,缝隙超一包(MAX_INTER_GAP_PX)即封顶并整行居中,余量退两侧。
 */
async function drawFlatRow(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  rowPacks: RenderPack[],
  areaStartX: number,
  areaW: number,
  baseY: number,
  priceTagMap?: ReadonlyMap<string, number>,
  capGap: boolean = true,
  boxSink?: BoxRegion[],
): Promise<void> {
  const packs = rowPacks;
  if (packs.length === 0) return;

  // 组键间隙:红框配对的 L/R 紧贴(无 gap),红框两侧留 gap;普通包按 id 切换留 gap。
  const isGap = (prev: RenderPack, cur: RenderPack): boolean => {
    if (cur.boxRole === 'R') return false;       // 副规格紧贴其主规格
    if (cur.boxRole === 'L') return true;        // 红框前留 gap
    if (prev.boxRole === 'R') return true;       // 红框后留 gap
    return cur.spec.id !== prev.spec.id;         // 普通:id 切换处留 gap
  };

  let diffTransitions = 0;
  for (let i = 1; i < packs.length; i++) {
    if (isGap(packs[i - 1], packs[i])) diffTransitions++;
  }

  const totalPackW = packs.length * CELL_W;
  const gapBudget = Math.max(areaW - totalPackW, 0);
  let interGap = diffTransitions > 0 ? gapBudget / diffTransitions : 0;
  let startX = diffTransitions > 0
    ? areaStartX
    : areaStartX + (areaW - totalPackW) / 2;

  // capGap=true(专区行 / 专区模式常规行):组间空隙钳到 [GAP_MIN_PX, MAX_INTER_GAP_PX]、整体居中。
  // 防溢出:过密(连 GAP_MIN 都放不下)时放宽到 < GAP_MIN(直至 0),并左对齐,避免画出界外。
  if (capGap && diffTransitions > 0) {
    const fit = gapBudget / diffTransitions;
    interGap = fit >= GAP_MIN_PX ? Math.min(fit, MAX_INTER_GAP_PX) : Math.max(0, fit);
    const contentW = totalPackW + diffTransitions * interGap;
    startX = areaStartX + (areaW - contentW) / 2;
    if (startX < areaStartX) startX = areaStartX;   // 防左溢出
  }

  // 画包,记录每包左上角 x(供后续画红框)
  const xs: number[] = new Array(packs.length);
  let cursor = startX;
  for (let col = 0; col < packs.length; col++) {
    if (col > 0) {
      cursor += CELL_W;
      if (isGap(packs[col - 1], packs[col])) cursor += interGap;
    }
    xs[col] = cursor;
    await drawSpec(ctx, packs[col].spec, cursor, baseY, CELL_W, CELL_H, priceTagMap);
  }

  // 配对框 + 标签叠加在烟包之上;框线落配对自身 2 格 footprint 内侧,绝不覆盖相邻规格。
  for (let col = 0; col + 1 < packs.length; col++) {
    if (packs[col].boxRole === 'L' && packs[col + 1].boxRole === 'R') {
      const xLeft = xs[col];
      const xRight = xs[col + 1] + CELL_W;
      drawInlineBox(
        ctx, xLeft, xRight, baseY,
        packs[col].boxLabel || '',
        packs[col].boxColor || INLINE_BOX_COLOR_DEFAULT,
      );
      // 回收该对的像素区域,供整图完成后裁出"局部特写"(每对一张)
      if (boxSink) {
        boxSink.push({
          xLeft, xRight, baseY,
          zoneId: packs[col].boxZoneId,
          primaryId: packs[col].spec.id,
          secondaryId: packs[col + 1].spec.id,
        });
      }
    }
  }
}

/**
 * 画内嵌配对框 + 左上角标签。框线落在配对自身 2 格 footprint 内侧(inset = 线宽/2 + 1),
 * 因此无论相邻包多紧都不会覆盖相邻规格;标签条压在配对自身顶边内(同色底白字)。
 * color 由专区决定:产品升级=绿、滞销平替=紫。
 */
function drawInlineBox(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  xLeft: number,
  xRight: number,
  baseY: number,
  label: string,
  color: string,
): void {
  const lw = INLINE_BOX_LINE_W;
  const inset = lw / 2 + 1;
  const x = xLeft + inset;
  const y = baseY + inset;
  const w = (xRight - xLeft) - 2 * inset;
  const h = CELL_H - 2 * inset;
  if (w <= 0 || h <= 0) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.strokeRect(x, y, w, h);

  if (label) {
    const tabH = INLINE_BOX_TAB_H;
    const fontSize = tabH - 8;
    ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(label).width;
    const tabW = Math.min(w, textW + 12);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, tabW, tabH);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(label, x + 6, y + tabH / 2 + 1);
  }
}

/**
 * 绘制分组专区行(重点推荐区):每组 primary + alternatives 单包紧贴(组内不留空);
 * 组与组之间空隙由 placeUnitsClamped 钳到 [GAP_MIN_PX, MAX_INTER_GAP_PX]、整体居中。
 * 退市 primary 左上角叠 ★ 星标。组宽 = (1 + alternatives.length)·CELL_W。
 */
async function drawGroupedZoneRow(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  groups: ZonePlacementGroup[],
  areaStartX: number,
  areaW: number,
  baseY: number,
  priceTagMap?: ReadonlyMap<string, number>,
): Promise<void> {
  if (groups.length === 0) return;

  const groupWidths = groups.map(g => (1 + g.alternatives.length) * CELL_W);
  const xs = placeUnitsClamped(groupWidths, areaStartX, areaW);

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    let cursor = xs[gi];
    // primary 单包;退市规格叠星标(类价签形式,左上角)
    await drawSpec(ctx, g.primary, cursor, baseY, CELL_W, CELL_H, priceTagMap);
    if (g.primary.is_delisted) drawDelistedStar(ctx, cursor, baseY, PRICE_TAG_H);
    cursor += CELL_W;
    for (const alt of g.alternatives) {
      await drawSpec(ctx, alt, cursor, baseY, CELL_W, CELL_H, priceTagMap);
      cursor += CELL_W;
    }
  }
}

/**
 * 绘制工商共育「条行」:units 个条单元(≤2),每单元 = 1 条(5包宽) + 3 包(同规格)。
 * 行结构:[margin] 条 [gap_cp] 包 [gap_pp] 包 [gap_pp] 包 [gap_unit] 条 ... [margin]
 *  - 包-包小缝隙 packGap(偏小,COOP_MIN_PACK_GAP);条-包 / 单元间 / 两侧外边距 均分剩余宽度;
 *  - 内容 + 最小包缝隙 > 行宽时整行按宽度等比缩放塞入(窄柜兜底,高度仍占满 CELL_H)。
 * 条行不画价签(政策曝光位)。
 */
async function drawIndustrialCoopRow(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  units: Category[],
  areaStartX: number,
  areaW: number,
  baseY: number,
): Promise<void> {
  const n = units.length;
  if (n === 0) return;

  // 每单元不可压缩的最小宽 = 条 + 3包 + 2 个小缝隙;可调间隙位 = 左右边距(2) + 单元间(n-1) + 条-包(n) = 2n+1
  const fixedPerUnit = CARTON_W + COOP_PACKS_PER_UNIT * CELL_W + (COOP_PACKS_PER_UNIT - 1) * COOP_MIN_PACK_GAP;
  const totalFixed = n * fixedPerUnit;
  const adjustableSlots = 2 * n + 1;

  let scale = 1;
  let packGap = COOP_MIN_PACK_GAP;
  let adjGap = 0;
  if (totalFixed > areaW) {
    // 窄柜:无可调间隙,整行(含最小包缝)按宽度等比缩放塞入
    scale = areaW / totalFixed;
    packGap = COOP_MIN_PACK_GAP * scale;
  } else {
    adjGap = (areaW - totalFixed) / adjustableSlots;
  }
  const cw = CARTON_W * scale;
  const pw = CELL_W * scale;

  let cursor = areaStartX + adjGap;  // 左边距
  for (let u = 0; u < n; u++) {
    if (u > 0) cursor += adjGap;     // 单元之间的间隙
    await drawCarton(ctx, units[u], cursor, baseY, cw, CELL_H);
    cursor += cw + adjGap;           // 条 → 包 之间的间隙
    for (let p = 0; p < COOP_PACKS_PER_UNIT; p++) {
      if (p > 0) cursor += packGap;  // 3 包之间的小缝隙
      await drawSpec(ctx, units[u], cursor, baseY, pw, CELL_H);  // 不传 priceTagMap → 不画价签
      cursor += pw;
    }
  }
}

/**
 * 绘制单个「条」(carton)图。条图按 {卷烟编码}_ti.jpg 命名(在包图 imageUrl 后缀前插 _ti),
 * 缺图时画占位条(深灰底 + 名称 + "条")。条图宽 = 5 包宽,占满整行高 CELL_H。
 */
async function drawCarton(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  spec: Category,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> {
  // /images/categories/310143.jpg → /images/categories/310143_ti.jpg
  const cartonUrl = spec.imageUrl.replace(/(\.[^./]+)$/, '_ti$1');
  const imgPath = path.join(CATEGORY_IMG_ROOT, cartonUrl);
  if (fs.existsSync(imgPath)) {
    try {
      const img = await loadImage(imgPath);
      ctx.drawImage(img, x, y, w, h);
      return;
    } catch {
      // 加载失败 → 占位
    }
  }
  drawCartonPlaceholder(ctx, spec.name, x, y, w, h);
}

/**
 * 绘制「条」占位图:深灰底 + 边框 + 商品名(前 6 字) + "【条】待上传"。
 * 与包占位(drawPlaceholder)区分,提示上传 {编码}_ti.jpg 后即自动替换为真图。
 */
function drawCartonPlaceholder(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.fillStyle = '#D8CFC0';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#B0A48E';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

  const lines = [name.slice(0, 6), '【条】待上传'];
  ctx.fillStyle = '#7A6F5A';
  ctx.font = `bold 20px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = 28;
  const startY = y + h / 2 - ((lines.length - 1) * lineH) / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x + w / 2, startY + i * lineH);
  }
}

/**
 * 尝鲜专区布局(返回每行显式坐标 + 店长推荐高亮带):每个新品 = 正反对(宽 NP_UNIT_W,画幅统一)。
 * 全行单元(店长推荐 + 其余新品)用 placeUnitsClamped **统一间隙、整行居中**(相对位置居中,不强行像素居中);
 * 店长推荐排 ceil(n/2) 列 × 2 行的居中方块(6→3×2),两块行用相同"左侧 others 数 + 相同总单元数"保证上下对齐。
 * 其余新品用 sortCategories(**产地集中 + 价格高→低,同新客户常规陈列策略**)排序;块垂直居中;高亮带从 special 实际 x 取。
 */
function layoutNewProductZone(zone: ZonePlacement, areaW: number): NpRowLayout[] {
  const R = Math.max(1, zone.rowCount);
  const allSpecs = zone.groups.map(g => g.primary);
  const highlightIds = zone.highlightIds ?? [];
  const highlightSet = new Set(highlightIds);
  const byId = new Map(allSpecs.map(s => [s.id, s]));

  const specials: Category[] = [];
  for (const id of highlightIds) { const c = byId.get(id); if (c) specials.push(c); }
  // 其余新品:产地集中 + 价格从高到低(产地/品牌顺序同新客户常规陈列 sortCategories)
  const others = sortCategories(allSpecs.filter(s => !highlightSet.has(s.id)));

  const U = NP_UNIT_W;
  const cap = maxUnitsPerRow(areaW, U);   // 每行最多正反对数(GAP_MIN 下)
  let oi = 0;
  const takeOthers = (n: number): Category[] => {
    const k = Math.max(0, Math.min(n, others.length - oi));
    const arr = others.slice(oi, oi + k);
    oi += k;
    return arr;
  };
  // 一行单元(全 U 宽)统一间隙、整行居中铺开 → 带 x 的单元
  const layRow = (units: { spec: Category; special: boolean }[]): NpPlacedUnit[] => {
    const xs = placeUnitsClamped(units.map(() => U), 0, areaW);
    return units.map((u, i) => ({ spec: u.spec, special: u.special, x: xs[i] }));
  };

  const rows: NpRowLayout[] = Array.from({ length: R }, () => ({ units: [] as NpPlacedUnit[] }));

  if (specials.length === 0) {
    // 无在售重点品规:others 均匀分布到各行(每行 ≤ cap)
    const perRow = uniformDistribute(Math.min(others.length, cap * R), R);
    for (let r = 0; r < R; r++) {
      rows[r].units = layRow(takeOthers(Math.min(perRow[r], cap)).map(c => ({ spec: c, special: false })));
    }
    return rows;
  }

  // 店长推荐方块(row-major,2 行均衡分列):n 个 → ceil(n/2) 列 × 2 行(6→3×2;4→2×2;5→[3,2];3→[2,1]);
  // ≤2 或单行专区(R<2)→ 单行铺开。
  let blockGrid: Category[][];
  if (R < 2 || specials.length <= 2) blockGrid = [specials];
  else { const half = Math.ceil(specials.length / 2); blockGrid = [specials.slice(0, half), specials.slice(half)]; }
  const blockRows = blockGrid.length;
  const blockCols = Math.max(...blockGrid.map(g => g.length));   // 最宽块行列数(= ceil(n/2))
  const blockTopRow = Math.min(Math.max(0, Math.floor((R - blockRows) / 2)), R - blockRows);

  // 每行(含 specials)目标单元数:≥ 块列数、尽量均匀、封顶 cap;块行左侧 others 数 leftN 两块行相同 → special 同 x → 对齐
  const perRow = Math.min(cap, Math.max(blockCols, Math.ceil((others.length + specials.length) / R)));
  const leftN = Math.max(0, Math.floor((perRow - blockCols) / 2));

  for (let r = 0; r < R; r++) {
    const bi = r - blockTopRow;
    if (bi >= 0 && bi < blockRows) {
      const rowSpecials = blockGrid[bi];
      const oTotal = Math.max(0, perRow - rowSpecials.length);   // 本块行 others 总数(保证总单元 ≈ perRow)
      const leftCount = Math.min(leftN, oTotal);
      const left = takeOthers(leftCount).map(c => ({ spec: c, special: false }));
      const center = rowSpecials.map(s => ({ spec: s, special: true }));
      const right = takeOthers(oTotal - left.length).map(c => ({ spec: c, special: false }));
      const units = layRow([...left, ...center, ...right]);
      const specXs = units.filter(u => u.special).map(u => u.x);
      rows[r] = {
        units,
        bgBand: {
          x0: Math.max(0, Math.min(...specXs) - MANAGER_PICK_PAD),
          x1: Math.min(areaW, Math.max(...specXs) + U + MANAGER_PICK_PAD),
          withThumb: bi === blockRows - 1,
        },
      };
    } else {
      rows[r] = { units: layRow(takeOthers(perRow).map(c => ({ spec: c, special: false }))) };
    }
  }
  return rows;
}

/**
 * 绘制尝鲜专区行(按 layoutNewProductZone 算好的显式 x):先铺店长推荐高亮背景带(块行),
 * 再画各单元(正面 drawSpec + 反面 drawBackFace,均 CELL_W 统一画幅),最后底块行右下角画👍。
 * row.units[*].x / bgBand 的 x 相对陈列区起点,这里整体偏移 areaStartX(= 左侧标签栏宽 labelW)。
 */
async function drawNewProductRow(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  row: NpRowLayout,
  areaStartX: number,
  baseY: number,
  priceTagMap?: ReadonlyMap<string, number>,
): Promise<void> {
  // 1) 店长推荐高亮背景带(块行):柔金底 + 描边,满行高
  if (row.bgBand) {
    const bx = areaStartX + row.bgBand.x0;
    const bw = row.bgBand.x1 - row.bgBand.x0;
    if (bw > 0) {
      ctx.fillStyle = MANAGER_PICK_BG;
      ctx.fillRect(bx, baseY, bw, CELL_H);
      ctx.strokeStyle = MANAGER_PICK_BG_BORDER;
      ctx.lineWidth = 2;
      ctx.strokeRect(bx + 1, baseY + 1, bw - 2, CELL_H - 2);
    }
  }
  // 2) 烟包:正面 + 反面紧贴(画幅统一 CELL_W)
  for (const u of row.units) {
    const x = areaStartX + u.x;
    await drawSpec(ctx, u.spec, x, baseY, CELL_W, CELL_H, priceTagMap);       // 正面(含价签)
    await drawBackFace(ctx, u.spec, x + CELL_W, baseY, CELL_W, CELL_H);       // 反面(不画价签)
  }
  // 3) 👍:底块行高亮带右下角(资产优先,缺图矢量兜底)
  if (row.bgBand?.withThumb) {
    const sz = Math.round(0.6 * CELL_W);
    await drawManagerThumb(ctx, areaStartX + row.bgBand.x1 - sz - 6, baseY + CELL_H - sz - 6, sz);
  }
}

/**
 * 绘制新品反面图。反面按 {卷烟编码}_b.jpg 命名(在包图 imageUrl 后缀前插 _b),缺图画"背面待上传"占位。
 */
async function drawBackFace(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  spec: Category,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> {
  // /images/categories/310140.jpg → /images/categories/310140_b.jpg
  const backUrl = spec.imageUrl.replace(/(\.[^./]+)$/, '_b$1');
  const imgPath = path.join(CATEGORY_IMG_ROOT, backUrl);
  if (fs.existsSync(imgPath)) {
    try {
      const img = await loadImage(imgPath);
      ctx.drawImage(img, x, y, w, h);
      return;
    } catch {
      // 加载失败 → 占位
    }
  }
  drawBackPlaceholder(ctx, spec.name, x, y, w, h);
}

/** 反面占位图:浅灰底 + 边框 + 商品名(前 6 字) + "背面待上传"。提示上传 {编码}_b.jpg 后自动替换。 */
function drawBackPlaceholder(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.fillStyle = '#D8CFC0';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#B0A48E';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

  const lines = [name.slice(0, 6), '背面待上传'];
  ctx.fillStyle = '#7A6F5A';
  ctx.font = `bold 18px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = 26;
  const startY = y + h / 2 - ((lines.length - 1) * lineH) / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x + w / 2, startY + i * lineH);
  }
}

/**
 * 绘制店长推荐👍:优先载入资产 /images/decor/thumb.png(用户上传),缺图走矢量兜底 drawVectorThumb。
 * (x, y, size) = 左上角 + 边长。
 */
async function drawManagerThumb(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  x: number,
  y: number,
  size: number,
): Promise<void> {
  const p = path.join(CATEGORY_IMG_ROOT, MANAGER_THUMB_PATH);
  if (fs.existsSync(p)) {
    try {
      const img = await loadImage(p);
      ctx.drawImage(img, x, y, size, size);
      return;
    } catch {
      // 加载失败 → 矢量兜底
    }
  }
  drawVectorThumb(ctx, x, y, size);
}

/** 矢量大拇指兜底:红圆底 + 白色简化"竖拇指"(资产缺失时用,保证总能显示)。 */
function drawVectorThumb(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  x: number,
  y: number,
  size: number,
): void {
  const cx = x + size / 2, cy = y + size / 2, r = size / 2;
  ctx.fillStyle = '#E63946';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  const u = size / 10;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(cx - 2 * u, cy - 0.5 * u, 3.6 * u, 3.8 * u);    // 手掌
  ctx.fillRect(cx - 1.1 * u, cy - 3 * u, 1.7 * u, 3 * u);      // 竖起的拇指
  ctx.fillRect(cx - 2.4 * u, cy + 2.8 * u, 4.2 * u, 1.1 * u);  // 袖口
}

/**
 * 绘制专区左侧说明标签:白底 + barColor 左侧粗色条 + barColor 竖排专区名(字号已 ×2)。
 * 高度可跨多行(同专区 rowCount > 1 合并为一条贯穿的 label)。
 *
 * iconPath(爆珠子专区用):左栏加宽,色条右侧为「图标列」——按 rowCount **逐行各画一个 ≈ 烟包大小的图标**
 * (子专区跨多行 → 每行行首都有;资产优先 CATEGORY_IMG_ROOT + iconPath,只加载一次逐行复用,缺图画 barColor
 * 色块占位),竖排专区名移到图标列右侧的文字带。不传 iconPath 时:竖排名在色条之外的整个内宽居中。
 *
 * 竖排名字号/行高用放大后的 ZONE_LABEL_FONT_SIZE/LINE_H;若字数 × 行高超出块高(如单行块放长名),
 * 等比缩小以避免溢出到层板(见 drawVerticalZoneName)。
 */
async function drawZoneLabel(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  barColor: string,
  iconPath?: string,
  rowCount?: number,
): Promise<void> {
  ctx.fillStyle = '#F5F0E8';
  ctx.fillRect(x, y, w, h);

  ctx.fillStyle = barColor;
  ctx.fillRect(x, y, ZONE_LABEL_BAR_W, h);

  // 竖排名占位区:有图标时收窄到右侧文字带,无图标时占色条之外的整个内宽
  let textLeft = x + ZONE_LABEL_BAR_W;
  const textRight = x + w;

  if (iconPath && rowCount && rowCount > 0) {
    const iconLeft = x + ZONE_LABEL_BAR_W;
    const iconRight = x + w - BEAD_LABEL_TEXT_W;
    const iconColW = Math.max(0, iconRight - iconLeft);
    const insetX = 4;
    const insetY = 6;
    const boxW = iconColW - 2 * insetX;
    const boxH = CELL_H - 2 * insetY;
    // 资产只加载一次,逐行复用绘制(子专区跨多行则每行行首一个 ≈ 烟包大图标)
    let iconImg: Awaited<ReturnType<typeof loadImage>> | null = null;
    const p = path.join(CATEGORY_IMG_ROOT, iconPath);
    if (fs.existsSync(p)) {
      try {
        iconImg = await loadImage(p);
      } catch {
        iconImg = null;  // 加载失败 → 落到色块占位
      }
    }
    if (boxW > 0 && boxH > 0) {
      for (let r = 0; r < rowCount; r++) {
        const bx = iconLeft + insetX;
        const by = y + r * (CELL_H + SHELF_BOARD_H) + insetY;
        if (iconImg) {
          ctx.drawImage(iconImg, bx, by, boxW, boxH);
        } else {
          ctx.fillStyle = barColor;
          ctx.fillRect(bx, by, boxW, boxH);
          ctx.strokeStyle = 'rgba(0,0,0,0.25)';
          ctx.lineWidth = 2;
          ctx.strokeRect(bx, by, boxW, boxH);
        }
      }
    }
    textLeft = iconRight;
  }

  drawVerticalZoneName(ctx, label, (textLeft + textRight) / 2, y, h, barColor);
}

/**
 * 竖排专区名(每字一行),在 centerX 水平居中、在块高 [blockY, blockY+blockH] 垂直居中。
 * 字数 × 行高超出块高时(如单行块放长名)等比缩小字号/行高,避免竖排文字溢出到层板。
 */
function drawVerticalZoneName(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  label: string,
  centerX: number,
  blockY: number,
  blockH: number,
  color: string,
): void {
  const chars = label.split('');
  if (chars.length === 0) return;
  let fontSize = ZONE_LABEL_FONT_SIZE;
  let lineH = ZONE_LABEL_LINE_H;
  const need = chars.length * lineH;
  if (need > blockH) {
    const scale = blockH / need;
    lineH = Math.max(1, Math.floor(lineH * scale));
    fontSize = Math.max(12, Math.floor(fontSize * scale));
  }
  ctx.fillStyle = color;
  ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const totalH = chars.length * lineH;
  let textY = blockY + Math.max(0, (blockH - totalH) / 2) + lineH / 2;
  for (const ch of chars) {
    ctx.fillText(ch, centerX, textY);
    textY += lineH;
  }
}

/**
 * 画单个 spec(图片或占位)+ 价签。w/h 为绘制目标尺寸,通常为 CELL_W × CELL_H。
 */
async function drawSpec(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  spec: Category,
  x: number,
  y: number,
  w: number,
  h: number,
  priceTagMap?: ReadonlyMap<string, number>,
): Promise<void> {
  const imgPath = path.join(CATEGORY_IMG_ROOT, spec.imageUrl);
  const hasFile = fs.existsSync(imgPath);

  if (hasFile) {
    try {
      const img = await loadImage(imgPath);
      ctx.drawImage(img, x, y, w, h);
    } catch {
      drawPlaceholder(ctx, spec.name, x, y, w, h);
    }
  } else {
    drawPlaceholder(ctx, spec.name, x, y, w, h);
  }

  const price = priceTagMap?.get(spec.id);
  if (price !== undefined) {
    drawPriceTag(ctx, price, x, y, w, h);
  }
}
