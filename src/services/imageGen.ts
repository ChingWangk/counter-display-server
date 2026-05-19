import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, loadImage } from 'canvas';
import { Counter, Category, LayoutConfig } from '../types';
import { ZonePlacement } from './strategies/types';

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

// 图片输出目录（服务器上 Nginx 静态文件目录）
const OUTPUT_DIR = '/www/wwwroot/47.103.65.4/images/generated';

// 品类图片根目录
const CATEGORY_IMG_ROOT = '/www/wwwroot/47.103.65.4';

// ---- 每行布局描述 ----
interface ZoneRowSlot {
  type: 'zone';
  specs: Category[];
  barColor: string;
}
interface RegularRowSlot {
  type: 'regular';
  specCount: number;
}
type RowSlot = ZoneRowSlot | RegularRowSlot;

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
 * 计算某种模式下每行最多能放几个规格（单包模式：packsPerSpec=1）
 */
function calcMaxPerRow(counterLengthPx: number, gapCm: number): number {
  const gapPx = Math.max(Math.round(gapCm * PX_PER_CM), 0);
  const slotW = CELL_W + gapPx;
  return Math.max(1, Math.floor((counterLengthPx + gapPx) / slotW));
}

/**
 * 为单个柜台生成陈列图片
 *
 * 行顺序:常规陈列行在上,zone 行紧贴底部。zone 行最左侧画 12px 色条标识专区。
 * 单柜台内多个 zone 按 (priorityRank ASC, specCount DESC) 排序,每个占用 rowCount 行
 * (1-4 行,单柜台累计 ≤ 4),行内 packsPerSpec=1 紧贴排列。
 * 常规陈列按 layout(expanded 留间距 / standard 紧贴)绘制 regularSpecs。
 *
 * @param zonePlacements 本柜台的专区落位列表(由 generate 路由按 counterId 筛选后传入)
 * @returns imageUrl 和消耗的 regular 品规数 usedCount(用于多柜台 offset)
 */
export async function generateCounterImage(
  counter: Counter,
  regularSpecs: Category[],
  layout: LayoutConfig = { mode: 'standard', gapCm: 0 },
  zonePlacements?: ZonePlacement[],
): Promise<{ imageUrl: string; usedCount: number }> {
  const canvasW = Math.round(counter.length * PX_PER_CM);
  const levels = counter.levels;

  if (canvasW <= 0 || levels <= 0) {
    throw new Error(`柜台 ${counter.id} 参数无效: length=${counter.length}, levels=${counter.levels}`);
  }

  const singleMaxPerRow = Math.floor(counter.length / PACK_WIDTH_CM);

  // ---- 1. 排序 zonePlacements,展开为 zone 行(每个 zone 占 rowCount 行) ----
  const sortedZones = (zonePlacements ?? [])
    .slice()
    .sort((a, b) => a.priorityRank - b.priorityRank || b.specCount - a.specCount);

  const zoneRowSlots: ZoneRowSlot[] = [];
  for (const zone of sortedZones) {
    const perRow = uniformDistribute(zone.specs.length, zone.rowCount);
    let off = 0;
    for (let r = 0; r < zone.rowCount; r++) {
      const want = perRow[r];
      const fit = Math.min(want, singleMaxPerRow);
      zoneRowSlots.push({
        type: 'zone',
        specs: zone.specs.slice(off, off + fit),
        barColor: zone.barColor,
      });
      off += want;
    }
  }

  const zoneRowCount = zoneRowSlots.length;
  const regularLevels = Math.max(0, levels - zoneRowCount);

  // ---- 2. 计算 regular 行布局(单包模式,expanded 或 standard) ----
  let regularRowLayouts: RegularRowSlot[];

  if (regularLevels === 0) {
    regularRowLayouts = [];
  } else {
    const maxPerRow = layout.mode === 'expanded'
      ? calcMaxPerRow(canvasW, layout.gapCm)
      : singleMaxPerRow;
    const totalUsed = Math.min(maxPerRow * regularLevels, regularSpecs.length);
    const perRow = layout.mode === 'standard'
      ? uniformDistribute(totalUsed, regularLevels)
      : staggeredDistribute(totalUsed, regularLevels);
    regularRowLayouts = perRow.map(n => ({ type: 'regular' as const, specCount: n }));
  }

  // 行槽顺序:常规在上,zone 在下(专区不再放在常规陈列之上层)
  const rowSlots: RowSlot[] = [...regularRowLayouts, ...zoneRowSlots];

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
  // 同 id 品规在行内紧贴(无缝);剩余空间均分到"不同 id 之间"的间隔;行内全同 id 或仅 1 个时退化为居中。
  let regularIdx = 0;
  for (let row = 0; row < levels; row++) {
    const slot = rowSlots[row];
    if (!slot) continue;

    let rowSpecs: Category[];
    if (slot.type === 'zone') {
      rowSpecs = slot.specs;
    } else {
      rowSpecs = placedRegular.slice(regularIdx, regularIdx + slot.specCount);
      regularIdx += slot.specCount;
    }
    if (rowSpecs.length === 0) continue;

    const baseY = PADDING_TOP + row * (CELL_H + SHELF_BOARD_H);

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

      const imgPath = path.join(CATEGORY_IMG_ROOT, rowSpecs[col].imageUrl);
      const hasFile = fs.existsSync(imgPath);

      if (hasFile) {
        try {
          const img = await loadImage(imgPath);
          ctx.drawImage(img, cursor, baseY, CELL_W, CELL_H);
        } catch {
          drawPlaceholder(ctx, rowSpecs[col].name, cursor, baseY, CELL_W, CELL_H);
        }
      } else {
        drawPlaceholder(ctx, rowSpecs[col].name, cursor, baseY, CELL_W, CELL_H);
      }
    }
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
  // zone 行位于柜台底部 zoneRowCount 行,即 rowSlots 索引 regularLevels..levels-1
  for (let row = regularLevels; row < levels; row++) {
    const slot = rowSlots[row];
    if (!slot || slot.type !== 'zone') continue;
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
