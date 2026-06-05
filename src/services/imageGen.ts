import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, loadImage, registerFont } from 'canvas';
import { Counter, Category } from '../types';
import { ZonePlacement, ZonePlacementGroup } from './strategies/types';

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

// 专区左侧说明标签宽度。标签写竖排专区名,左侧带粗色条强化,
// 在陈列区域外侧延伸,不挤占柜台陈列容量(包数)。
const ZONE_LABEL_W = 40;
const ZONE_LABEL_BAR_W = 4;   // 标签左侧粗色条宽度
const ZONE_LABEL_FONT_SIZE = 18;
const ZONE_LABEL_LINE_H = 24; // 竖排每字垂直占位

// 分组专区组与组之间至少留出的空隙(像素)。
// bin-packing 时把此值计入下一组的占用宽度,避免组与组紧贴显得拥挤。
const MIN_INTER_GROUP_GAP_PX = CELL_W;

// 专区行内任意两包(或两组)之间"空缝隙"的上限 = 一包烟宽度。
// 仅作用于内容固定、无法靠加排面填充的专区行(单品专区残量行 / 分组专区组间):
// 缝隙超过一包即封顶,并把多余空间退到行两侧(居中),避免出现"一包多宽"的空档。
// 规整陈列行(double/expanded/standard)不受此上限约束 —— 空隙均匀撑满整行宽、两端对齐。
const MAX_INTER_GAP_PX = CELL_W;

// 价签尺寸（贴在烟包底部）
const PRICE_TAG_H = 26;
const PRICE_TAG_FONT = `bold 16px ${FONT_FAMILY}`;

// 图片输出目录（服务器上 Nginx 静态文件目录）
const OUTPUT_DIR = '/www/wwwroot/47.103.65.4/images/generated';

// 品类图片根目录
const CATEGORY_IMG_ROOT = '/www/wwwroot/47.103.65.4';

// ---- 每行布局描述 ----
// 单品专区行:specs 是扁平 Category[],每包紧贴,按 id 切换处留 gap(与常规行算法一致)
interface ZoneSingleRowSlot {
  type: 'zone-single';
  specs: Category[];
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
type RowSlot = ZoneSingleRowSlot | ZoneGroupRowSlot | ZoneCartonRowSlot | RegularRowSlot;

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

// 同一专区跨 rowCount 行的合并标签信息:左侧画一条贯穿全部行的竖向 label
interface ZoneLabelBlock {
  startRow: number;  // 在最终行网格中的绝对起始行 index (0-based)
  rowCount: number;
  label: string;
  barColor: string;
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
 * 为单个柜台生成陈列图片
 *
 * 整张画布:左侧 labelW 宽的"专区标签栏"(仅当本柜台有专区行时才预留,否则 labelW=0) +
 * 右侧陈列区域(width = counter.length × PX_PER_CM)。标签栏不挤占陈列容量(包数),仅在画布
 * 外侧延伸。无专区的柜台(新客户 / 未启用专区)labelW=0,陈列区贴画布左缘,左侧无空白预留位。
 *
 * 行布局自上而下:
 *   [顶部] fixedTop 条行(工商共育):每行 条+3包+条+3包,固定在柜台最顶,把常规行整体下移
 *   [中部] 常规陈列(无专区时走三档 double/expanded/standard,详见 RegularFillLayout;行内空隙撑满整行宽)
 *   [底部] 其余功能专区(左侧标签栏画专区名,同专区跨多行合并为一条):
 *     - 单品专区(newProduct/beadFlavor):
 *       · newProduct:自适应密度,稀疏时双包陈列,否则单包并保证至少 1 包宽 gap budget
 *       · beadFlavor:始终单包,cap = packsPerRow - 1
 *     - 分组专区(substitute/productUpgrade/keyRecommend):primary + 每个 alternative 均单包陈列,
 *       组与组之间至少留 MIN_INTER_GROUP_GAP_PX 宽空隙;keyRecommend 的滞销组 alternatives=[] 只画 primary
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
 */
export async function generateCounterImage(
  counter: Counter,
  regularSpecs: Category[],
  regularRows: number,
  zonePlacements?: ZonePlacement[],
  priceTagMap?: ReadonlyMap<string, number>,
  regularLayout?: RegularFillLayout,
): Promise<{ imageUrl: string; usedCount: number }> {
  const displayAreaW = Math.round(counter.length * PX_PER_CM);
  const levels = counter.levels;

  if (displayAreaW <= 0 || levels <= 0) {
    throw new Error(`柜台 ${counter.id} 参数无效: length=${counter.length}, levels=${counter.levels}`);
  }

  const singleMaxPerRow = Math.floor(counter.length / PACK_WIDTH_CM);

  // ---- 1. 计算常规行布局 ----
  const clampedRegularRows = Math.max(0, Math.min(regularRows, levels));
  let regularRowLayouts: RegularRowSlot[];
  // 实际要绘制的常规包列表:double 模式下每品规翻倍为两包,其余模式即 regularSpecs 本身。
  let regularPacks: Category[] = regularSpecs;
  if (clampedRegularRows === 0 || regularSpecs.length === 0) {
    regularRowLayouts = [];
  } else if (regularLayout) {
    // 无专区铺满模式(归档版三档):铺满整柜所有层,按 mode 决定双包与分布方式。
    //  - double:  先把每个品规翻倍为两包(同 id 紧贴),再 staggered 分布到各行
    //  - expanded:单包,staggered 分布(空隙由 drawFlatRow 均匀撑满整行宽)
    //  - standard:单包,uniform 分布(每行铺满,gap≈0)
    if (regularLayout.mode === 'double') {
      regularPacks = regularSpecs.flatMap(s => [s, s]);
    }
    const distribute = regularLayout.mode === 'standard' ? uniformDistribute : staggeredDistribute;
    const perRow = distribute(regularPacks.length, clampedRegularRows);
    regularRowLayouts = perRow.map(n => ({ type: 'regular' as const, specCount: n }));
  } else {
    // 专区模式:常规顶部 cram,容量 = singleMaxPerRow × rows,余量留给底部专区行
    const totalUsed = Math.min(singleMaxPerRow * clampedRegularRows, regularSpecs.length);
    const perRow = staggeredDistribute(totalUsed, clampedRegularRows);
    regularRowLayouts = perRow.map(n => ({ type: 'regular' as const, specCount: n }));
  }

  // ---- 2. 拆分专区:fixedTop(工商共育条行,固定在柜台最顶) vs 其余(常规之下的底部专区) ----
  const allZones = (zonePlacements ?? []).slice();
  const topZonePlacements = allZones.filter(z => z.layoutKind === 'fixedTop');
  const bottomZonePlacements = allZones
    .filter(z => z.layoutKind !== 'fixedTop')
    .sort((a, b) => a.priorityRank - b.priorityRank || b.groupCount - a.groupCount);

  // 2a. 顶部 fixedTop 条行:每个 placement 的 groups(条单元)按 2 个/行切块为 zone-carton 行
  const topRowSlots: ZoneCartonRowSlot[] = [];
  const topLabelInfo: { rows: number; label: string; barColor: string }[] = [];
  for (const zone of topZonePlacements) {
    const units = zone.groups.map(g => g.primary);
    const rows = Math.max(0, Math.min(zone.rowCount, levels));
    for (let r = 0; r < rows; r++) {
      topRowSlots.push({ type: 'zone-carton', units: units.slice(r * 2, r * 2 + 2) });
    }
    if (rows > 0) topLabelInfo.push({ rows, label: zone.label, barColor: zone.barColor });
  }

  // 2b. 底部专区行:单品 staggered / 分组 bin-packing(逻辑同归档)
  const bottomRowSlots: (ZoneSingleRowSlot | ZoneGroupRowSlot)[] = [];
  const bottomLabelInfo: { rows: number; label: string; barColor: string }[] = [];
  for (const zone of bottomZonePlacements) {
    const before = bottomRowSlots.length;
    if (zone.displayMode === 'single') {
      // 单品专区:拉平 groups 为 primary 列表,等同于旧的 specs
      const flatSpecs = zone.groups.map(g => g.primary);
      const perRow = uniformDistribute(flatSpecs.length, zone.rowCount);
      // 仅新品尝鲜支持根据柜台余量自适应双包陈列(工商共育已走 fixedTop 条行,不再经此分支);
      // 其余单品专区(如爆珠口味组合)始终单包陈列(每个 spec 独立曝光,不强调"重复抢占"视觉)
      const canDoublePack = zone.zoneId === 'newProduct';
      let off = 0;
      for (let r = 0; r < zone.rowCount; r++) {
        const want = perRow[r];
        const rowSpecs = flatSpecs.slice(off, off + want);
        off += want;
        // 自适应密度,避免行内过于稀疏或过度拥挤:
        //  - 双包陈列(仅 newProduct):specs * 2 <= packsPerRow,每个 spec 重复 2 次紧贴,
        //    drawFlatRow 会在 id 切换处自动留 gap
        //  - 单包陈列:cap = packsPerRow - 1,保证至少 1 包宽度的 gap budget
        let renderSpecs: Category[];
        if (canDoublePack && rowSpecs.length > 0 && rowSpecs.length * 2 <= singleMaxPerRow) {
          renderSpecs = rowSpecs.flatMap(s => [s, s]);
        } else {
          const cap = Math.max(1, singleMaxPerRow - 1);
          renderSpecs = rowSpecs.slice(0, cap);
        }
        bottomRowSlots.push({ type: 'zone-single', specs: renderSpecs });
      }
    } else {
      // 分组专区:按行宽贪心分组,整组不可拆,超出本行行宽就换行
      //   primary 和每个 alternative 均占 1 包宽(单包陈列)
      //   一组宽度 = 1 + alts.length(2 个替代 → 3 包宽; 1 个替代 → 2 包宽,残缺组已排到末尾)
      //   组与组之间预留 MIN_INTER_GROUP_GAP_PX,bin-packing 时把它计入下一组占用
      const rowsOfGroups: ZonePlacementGroup[][] = [];
      let curRow: ZonePlacementGroup[] = [];
      let curWidthPx = 0;
      for (const g of zone.groups) {
        const gWidthPx = (1 + g.alternatives.length) * CELL_W;
        if (gWidthPx > displayAreaW) continue;  // 一组都放不下整行,跳过
        const need = curRow.length === 0
          ? gWidthPx
          : curWidthPx + MIN_INTER_GROUP_GAP_PX + gWidthPx;
        if (need > displayAreaW) {
          rowsOfGroups.push(curRow);
          curRow = [g];
          curWidthPx = gWidthPx;
        } else {
          curRow.push(g);
          curWidthPx = need;
        }
      }
      if (curRow.length > 0) rowsOfGroups.push(curRow);

      // 把 rowsOfGroups 映射到 zone.rowCount 行(超出 rowCount 的丢弃,autoExpand 通常已给够行数)
      for (let r = 0; r < zone.rowCount; r++) {
        bottomRowSlots.push({ type: 'zone-group', groups: rowsOfGroups[r] ?? [] });
      }
    }
    bottomLabelInfo.push({ rows: bottomRowSlots.length - before, label: zone.label, barColor: zone.barColor });
  }

  // ---- 3. 行槽装配:顶部条行 → 常规 → 底部专区 → 空闲(slot 为 undefined) ----
  const rowSlots: (RowSlot | undefined)[] = new Array(levels).fill(undefined);
  let fillRow = 0;
  for (const s of topRowSlots) { if (fillRow < levels) rowSlots[fillRow++] = s; }
  for (let i = 0; i < regularRowLayouts.length && fillRow < levels; i++) rowSlots[fillRow++] = regularRowLayouts[i];
  const bottomStartRow = fillRow;
  for (let i = 0; i < bottomRowSlots.length && fillRow < levels; i++) rowSlots[fillRow++] = bottomRowSlots[i];

  // 标签块(绝对起始行):顶部从 0 累加,底部从 bottomStartRow 累加
  const zoneLabelBlocks: ZoneLabelBlock[] = [];
  let topCursor = 0;
  for (const info of topLabelInfo) {
    zoneLabelBlocks.push({ startRow: topCursor, rowCount: info.rows, label: info.label, barColor: info.barColor });
    topCursor += info.rows;
  }
  let bottomCursor = bottomStartRow;
  for (const info of bottomLabelInfo) {
    zoneLabelBlocks.push({ startRow: bottomCursor, rowCount: info.rows, label: info.label, barColor: info.barColor });
    bottomCursor += info.rows;
  }

  // 左侧专区标签栏仅在本柜台确有专区行(顶部条行或底部专区)时才预留宽度;否则 labelW=0,陈列区贴左缘。
  const labelW = (topRowSlots.length > 0 || bottomRowSlots.length > 0) ? ZONE_LABEL_W : 0;

  // ---- 实际使用的 regular 包数(double 模式下 regularPacks 已翻倍)----
  const usedCount = regularRowLayouts.reduce((s, r) => s + r.specCount, 0);
  const placedRegular = regularPacks.slice(0, usedCount);

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

    let rowSpecs: Category[];
    let capGap = false;
    if (slot.type === 'zone-single') {
      // 单品专区残量行:内容固定不可加排面,空隙超一包即封顶并整行居中(capGap=true)
      rowSpecs = slot.specs;
      capGap = true;
    } else {
      // 规整陈列行:double/expanded/standard 的包列表与行分布已在上游算好;
      // 行内空隙均匀撑满整行宽、两端对齐(capGap=false,不封顶不居中)。
      rowSpecs = placedRegular.slice(regularIdx, regularIdx + slot.specCount);
      regularIdx += slot.specCount;
    }
    if (rowSpecs.length === 0) continue;

    await drawFlatRow(ctx, rowSpecs, labelW, displayAreaW, baseY, priceTagMap, capGap);
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
    drawZoneLabel(ctx, 0, startY, ZONE_LABEL_W, endY - startY, block.label, block.barColor);
  }

  // ---- 输出文件 ----
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const filename = `counter_${counter.id}_${Date.now()}.png`;
  const outputPath = path.join(OUTPUT_DIR, filename);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);

  return { imageUrl: `/images/generated/${filename}`, usedCount };
}

/**
 * 绘制扁平行(常规 + 单品专区):同 id 紧贴,按 id 切换处加 gap,gap 由本行剩余宽度均分。
 * 烟包绘制于 [areaStartX, areaStartX + areaW] 区间内,左侧 areaStartX 留给专区标签栏。
 *
 * @param capGap 是否对超限空隙封顶并整行居中:
 *   - false(规整陈列行):空隙均匀撑满整行宽、两端对齐(double/expanded 的"扩大间距"语义)。
 *     包列表与稀疏度已由 generateCounterImage 的三档逻辑(double 翻倍 / 单包)在上游决定。
 *   - true(单品专区残量行):内容固定不可加排面,缝隙超一包(MAX_INTER_GAP_PX)即封顶并整行居中,余量退两侧。
 */
async function drawFlatRow(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  rowSpecs: Category[],
  areaStartX: number,
  areaW: number,
  baseY: number,
  priceTagMap?: ReadonlyMap<string, number>,
  capGap: boolean = true,
): Promise<void> {
  const packs = rowSpecs;

  let diffTransitions = 0;
  for (let i = 1; i < packs.length; i++) {
    if (packs[i].id !== packs[i - 1].id) diffTransitions++;
  }

  const totalPackW = packs.length * CELL_W;
  const gapBudget = Math.max(areaW - totalPackW, 0);
  let interGap = diffTransitions > 0 ? gapBudget / diffTransitions : 0;
  let startX = diffTransitions > 0
    ? areaStartX
    : areaStartX + (areaW - totalPackW) / 2;

  // 缝隙上限封顶(仅 capGap=true 的专区残量行):内容固定无法靠加排面填充,缝隙超一包时
  // 封顶并整体居中,余量退两侧。规整陈列行(capGap=false)不封顶,空隙均匀撑满整行宽、两端对齐。
  if (capGap && diffTransitions > 0 && interGap > MAX_INTER_GAP_PX) {
    interGap = MAX_INTER_GAP_PX;
    const contentW = totalPackW + diffTransitions * MAX_INTER_GAP_PX;
    startX = areaStartX + (areaW - contentW) / 2;
  }

  let cursor = startX;
  for (let col = 0; col < packs.length; col++) {
    if (col > 0) {
      cursor += CELL_W;
      if (packs[col].id !== packs[col - 1].id) cursor += interGap;
    }
    await drawSpec(ctx, packs[col], cursor, baseY, CELL_W, CELL_H, priceTagMap);
  }
}

/**
 * 绘制分组专区行:primary 和每个 alternative 都是单包陈列(1 cell);
 * 组内紧贴,组与组之间留 gap = gapBudget / (groups.length - 1)。
 *
 * 烟包绘制于 [areaStartX, areaStartX + areaW] 区间内,左侧 areaStartX 留给专区标签栏。
 *
 * 进入此函数前 bin-packing 已确保 (totalGroupW + (nGaps × MIN_INTER_GROUP_GAP_PX)) <= areaW,
 * 因此 interGap = gapBudget / nGaps 必 >= MIN_INTER_GROUP_GAP_PX,组间总能留出可见空隙。
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
  const totalGroupW = groupWidths.reduce((s, w) => s + w, 0);
  const nGaps = groups.length - 1;
  const gapBudget = Math.max(areaW - totalGroupW, 0);

  let interGap: number;
  let startX: number;
  if (nGaps === 0) {
    interGap = 0;
    startX = areaStartX + (areaW - totalGroupW) / 2;  // 单组居中
  } else {
    interGap = gapBudget / nGaps;
    startX = areaStartX;
    // 组间缝隙封顶一包宽:分组内容固定无法靠加排面填充,超限即封顶并整体居中,余量退两侧,
    // 避免组与组之间出现"一包多宽"的空档(与规整行的缝隙上限一致,全客户统一)。
    if (interGap > MAX_INTER_GAP_PX) {
      interGap = MAX_INTER_GAP_PX;
      const contentW = totalGroupW + nGaps * MAX_INTER_GAP_PX;
      startX = areaStartX + (areaW - contentW) / 2;
    }
  }

  let cursor = startX;
  for (let gi = 0; gi < groups.length; gi++) {
    if (gi > 0) cursor += interGap;
    const g = groups[gi];
    // primary 单包陈列:1 cell
    await drawSpec(ctx, g.primary, cursor, baseY, CELL_W, CELL_H, priceTagMap);
    cursor += CELL_W;
    // 每个 alternative 单包陈列:1 cell
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
 * 绘制专区左侧说明标签:白底 + barColor 左侧粗色条 + barColor 竖排专区名,
 * 高度可跨多行(用于同专区 rowCount > 1 时合并为一条贯穿的 label)。
 */
function drawZoneLabel(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  barColor: string,
): void {
  ctx.fillStyle = '#F5F0E8';
  ctx.fillRect(x, y, w, h);

  ctx.fillStyle = barColor;
  ctx.fillRect(x, y, ZONE_LABEL_BAR_W, h);

  ctx.fillStyle = barColor;
  ctx.font = `bold ${ZONE_LABEL_FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const chars = label.split('');
  const totalH = chars.length * ZONE_LABEL_LINE_H;
  const textCenterX = x + ZONE_LABEL_BAR_W + (w - ZONE_LABEL_BAR_W) / 2;
  let textY = y + (h - totalH) / 2 + ZONE_LABEL_LINE_H / 2;
  for (const ch of chars) {
    ctx.fillText(ch, textCenterX, textY);
    textY += ZONE_LABEL_LINE_H;
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
