import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, loadImage } from 'canvas';
import { Counter, Category } from '../types';
import { ZonePlacement, ZonePlacementGroup } from './strategies/types';

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

// 专区左侧色条宽度
const ZONE_BAR_WIDTH = 12;

// 价签尺寸（贴在烟包底部）
const PRICE_TAG_H = 26;
const PRICE_TAG_FONT = 'bold 16px sans-serif';

// 图片输出目录（服务器上 Nginx 静态文件目录）
const OUTPUT_DIR = '/www/wwwroot/47.103.65.4/images/generated';

// 品类图片根目录
const CATEGORY_IMG_ROOT = '/www/wwwroot/47.103.65.4';

// ---- 每行布局描述 ----
// 单品专区行:specs 是扁平 Category[],每包紧贴,按 id 切换处留 gap(与常规行算法一致)
interface ZoneSingleRowSlot {
  type: 'zone-single';
  specs: Category[];
  barColor: string;
}
// 分组专区行:groups 是 ZonePlacementGroup[],primary 占双倍宽 + alternatives 紧随,组与组之间留 gap
interface ZoneGroupRowSlot {
  type: 'zone-group';
  groups: ZonePlacementGroup[];
  barColor: string;
}
interface RegularRowSlot {
  type: 'regular';
  specCount: number;
}
type RowSlot = ZoneSingleRowSlot | ZoneGroupRowSlot | RegularRowSlot;

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
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = 24;
  const startY = y + h / 2 - ((lines.length - 1) * lineH) / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x + w / 2, startY + i * lineH);
  }
}

/**
 * 绘制价签：贴在烟包底部的黄底红字"¥XX.X"小标签。
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
  // 黄底
  ctx.fillStyle = '#FFD54F';
  ctx.fillRect(x, tagY, w, PRICE_TAG_H);
  // 黑色边框,1 px
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, tagY + 0.5, w - 1, PRICE_TAG_H - 1);
  // 红字
  ctx.fillStyle = '#C62828';
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
 * 行布局自上而下:
 *   层 0..regularRows-1: 常规陈列(单包,行内 staggered 分布;行内空隙由 canvas 均分)
 *   层 regularRows..regularRows+zoneRowCount-1: 功能专区(左侧 12px 色条)
 *     - 单品专区(industrialCoop/slowMoving/newProduct):每包紧贴,按 id 切换处留 gap
 *     - 分组专区(substitute/nostalgia):primary 占双倍宽 + alternatives 紧随,组与组之间留 gap
 *   层 regularRows+zoneRowCount..levels-1: 空闲层(仅画层板,不放品规)
 *
 * 单柜台多个 zone 按 (priorityRank ASC, groupCount DESC) 排序,每个占用 rowCount 行(已含 autoExpand)。
 *
 * @param regularRows 常规陈列实际占用的行数(由 generate 顺序分配后确定)
 * @param zonePlacements 本柜台的专区落位(rowCount 已经过 autoExpand 扩展)
 * @param priceTagMap spec_id → avg_price 映射;命中时在烟包底部画价签;缺省/空时不画
 */
export async function generateCounterImage(
  counter: Counter,
  regularSpecs: Category[],
  regularRows: number,
  zonePlacements?: ZonePlacement[],
  priceTagMap?: ReadonlyMap<string, number>,
): Promise<{ imageUrl: string; usedCount: number }> {
  const canvasW = Math.round(counter.length * PX_PER_CM);
  const levels = counter.levels;

  if (canvasW <= 0 || levels <= 0) {
    throw new Error(`柜台 ${counter.id} 参数无效: length=${counter.length}, levels=${counter.levels}`);
  }

  const singleMaxPerRow = Math.floor(counter.length / PACK_WIDTH_CM);

  // ---- 1. 计算常规行布局(staggered 分布到 regularRows 行) ----
  const clampedRegularRows = Math.max(0, Math.min(regularRows, levels));
  let regularRowLayouts: RegularRowSlot[];
  if (clampedRegularRows === 0 || regularSpecs.length === 0) {
    regularRowLayouts = [];
  } else {
    const totalUsed = Math.min(singleMaxPerRow * clampedRegularRows, regularSpecs.length);
    const perRow = staggeredDistribute(totalUsed, clampedRegularRows);
    regularRowLayouts = perRow.map(n => ({ type: 'regular' as const, specCount: n }));
  }

  // ---- 2. 排序 zonePlacements,展开为 zone 行 ----
  //   - 单品专区:把 groups 中所有 primary 拉平为 Category[],staggered 分布到 rowCount 行
  //   - 分组专区:整组不可拆,把 groups 按"行宽优先填满"分到 rowCount 行
  const sortedZones = (zonePlacements ?? [])
    .slice()
    .sort((a, b) => a.priorityRank - b.priorityRank || b.groupCount - a.groupCount);

  const zoneRowSlots: (ZoneSingleRowSlot | ZoneGroupRowSlot)[] = [];
  for (const zone of sortedZones) {
    if (zone.displayMode === 'single') {
      // 单品专区:拉平 groups 为 primary 列表,等同于旧的 specs
      const flatSpecs = zone.groups.map(g => g.primary);
      const perRow = uniformDistribute(flatSpecs.length, zone.rowCount);
      let off = 0;
      for (let r = 0; r < zone.rowCount; r++) {
        const want = perRow[r];
        const fit = Math.min(want, singleMaxPerRow);
        zoneRowSlots.push({
          type: 'zone-single',
          specs: flatSpecs.slice(off, off + fit),
          barColor: zone.barColor,
        });
        off += want;
      }
    } else {
      // 分组专区:按行宽贪心分组,整组不可拆,超出本行行宽就换行
      //   primary 占 2 包宽, alternatives 各占 1 包宽 → 一组宽度 = 2 + alts.length
      const rowsOfGroups: ZonePlacementGroup[][] = [];
      let curRow: ZonePlacementGroup[] = [];
      let curWidth = 0;
      for (const g of zone.groups) {
        const gWidth = 2 + g.alternatives.length;
        if (gWidth > singleMaxPerRow) continue;  // 一组都放不下整行,跳过该组
        if (curWidth + gWidth > singleMaxPerRow && curRow.length > 0) {
          rowsOfGroups.push(curRow);
          curRow = [];
          curWidth = 0;
        }
        curRow.push(g);
        curWidth += gWidth;
      }
      if (curRow.length > 0) rowsOfGroups.push(curRow);

      // 把 rowsOfGroups 映射到 zone.rowCount 行:
      //   - 若 rowsOfGroups.length <= rowCount:按顺序填,末行 padding 空行(只有色条)
      //   - 若 > rowCount:超出部分丢弃(autoExpand 应该已经给够行数,正常不会触发)
      for (let r = 0; r < zone.rowCount; r++) {
        zoneRowSlots.push({
          type: 'zone-group',
          groups: rowsOfGroups[r] ?? [],
          barColor: zone.barColor,
        });
      }
    }
  }
  const zoneRowCount = zoneRowSlots.length;

  // 行槽:常规在上 → 专区紧贴其后 → 剩余为空闲层(slot 为 undefined)
  const rowSlots: (RowSlot | undefined)[] = new Array(levels).fill(undefined);
  for (let i = 0; i < regularRowLayouts.length && i < levels; i++) {
    rowSlots[i] = regularRowLayouts[i];
  }
  const zoneStart = regularRowLayouts.length;
  for (let i = 0; i < zoneRowCount && zoneStart + i < levels; i++) {
    rowSlots[zoneStart + i] = zoneRowSlots[i];
  }

  // ---- 实际使用的 regular 规格数 ----
  const usedCount = regularRowLayouts.reduce((s, r) => s + r.specCount, 0);
  const placedRegular = regularSpecs.slice(0, usedCount);

  // ---- 画布尺寸 ----
  const shelfBoards = levels - 1;
  const PADDING_TOP = 2;
  const canvasH = levels * CELL_H + shelfBoards * SHELF_BOARD_H + PADDING_TOP * 2;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  // 背景色
  ctx.fillStyle = '#F5F0E8';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // ---- 逐行绘制品规 ----
  // 常规 / 单品专区:同 id 紧贴,按 id 切换处加 gap
  // 分组专区:组内紧贴(primary 双倍宽 + alts),组与组之间加 gap
  let regularIdx = 0;
  for (let row = 0; row < levels; row++) {
    const slot = rowSlots[row];
    if (!slot) continue;

    const baseY = PADDING_TOP + row * (CELL_H + SHELF_BOARD_H);

    if (slot.type === 'zone-group') {
      await drawGroupedZoneRow(ctx, slot.groups, canvasW, baseY, priceTagMap);
      continue;
    }

    let rowSpecs: Category[];
    if (slot.type === 'zone-single') {
      rowSpecs = slot.specs;
    } else {
      rowSpecs = placedRegular.slice(regularIdx, regularIdx + slot.specCount);
      regularIdx += slot.specCount;
    }
    if (rowSpecs.length === 0) continue;

    await drawFlatRow(ctx, rowSpecs, canvasW, baseY, priceTagMap);
  }

  // ---- 绘制层板 ----
  for (let r = 0; r < shelfBoards; r++) {
    const boardY = PADDING_TOP + (r + 1) * CELL_H + r * SHELF_BOARD_H;
    ctx.fillStyle = SHELF_BOARD_COLOR;
    ctx.fillRect(0, boardY, canvasW, SHELF_BOARD_H);
    ctx.fillStyle = SHELF_BOARD_SHADOW;
    ctx.fillRect(0, boardY + SHELF_BOARD_H - 2, canvasW, 2);
  }

  // ---- 绘制 zone 行左侧色条(最后绘制以盖在烟包之上,确保可见) ----
  for (let row = zoneStart; row < zoneStart + zoneRowCount; row++) {
    const slot = rowSlots[row];
    if (!slot || (slot.type !== 'zone-single' && slot.type !== 'zone-group')) continue;
    const baseY = PADDING_TOP + row * (CELL_H + SHELF_BOARD_H);
    ctx.fillStyle = slot.barColor;
    ctx.fillRect(0, baseY, ZONE_BAR_WIDTH, CELL_H);
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
 * 绘制扁平行(常规 + 单品专区):同 id 紧贴,按 id 切换处加 gap
 */
async function drawFlatRow(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  rowSpecs: Category[],
  canvasW: number,
  baseY: number,
  priceTagMap?: ReadonlyMap<string, number>,
): Promise<void> {
  let diffTransitions = 0;
  for (let i = 1; i < rowSpecs.length; i++) {
    if (rowSpecs[i].id !== rowSpecs[i - 1].id) diffTransitions++;
  }

  const totalPackW = rowSpecs.length * CELL_W;
  const gapBudget = Math.max(canvasW - totalPackW, 0);
  const interGap = diffTransitions > 0 ? gapBudget / diffTransitions : 0;
  const startX = diffTransitions > 0 ? 0 : (canvasW - totalPackW) / 2;

  let cursor = startX;
  for (let col = 0; col < rowSpecs.length; col++) {
    if (col > 0) {
      cursor += CELL_W;
      if (rowSpecs[col].id !== rowSpecs[col - 1].id) cursor += interGap;
    }
    await drawSpec(ctx, rowSpecs[col], cursor, baseY, CELL_W, CELL_H, priceTagMap);
  }
}

/**
 * 绘制分组专区行:每组 primary 占 2*CELL_W 双倍宽,alternatives 各占 CELL_W;
 * 组内紧贴,组与组之间留 gap = gapBudget / (groups.length - 1)。
 *
 * primary 双倍宽的画法:把 primary 图片拉伸到 2*CELL_W × CELL_H(loadImage 保持原宽高比)。
 * 价签按"双倍宽"贴满 primary 底部。
 */
async function drawGroupedZoneRow(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  groups: ZonePlacementGroup[],
  canvasW: number,
  baseY: number,
  priceTagMap?: ReadonlyMap<string, number>,
): Promise<void> {
  if (groups.length === 0) return;

  const groupWidths = groups.map(g => (2 + g.alternatives.length) * CELL_W);
  const totalGroupW = groupWidths.reduce((s, w) => s + w, 0);
  const gapBudget = Math.max(canvasW - totalGroupW, 0);
  const interGap = groups.length > 1 ? gapBudget / (groups.length - 1) : 0;
  const startX = groups.length > 1 ? 0 : (canvasW - totalGroupW) / 2;

  let cursor = startX;
  for (let gi = 0; gi < groups.length; gi++) {
    if (gi > 0) cursor += interGap;
    const g = groups[gi];
    // primary: 双倍宽
    await drawSpec(ctx, g.primary, cursor, baseY, CELL_W * 2, CELL_H, priceTagMap);
    cursor += CELL_W * 2;
    // alternatives: 单倍宽,紧贴
    for (const alt of g.alternatives) {
      await drawSpec(ctx, alt, cursor, baseY, CELL_W, CELL_H, priceTagMap);
      cursor += CELL_W;
    }
  }
}

/**
 * 画单个 spec(图片或占位)+ 价签。w/h 为绘制目标尺寸,允许非 CELL_W × CELL_H(供 primary 双倍宽)。
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
