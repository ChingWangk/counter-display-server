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
  packsPerSpec: 1;
}
interface RegularRowSlot {
  type: 'regular';
  specCount: number;
  packsPerSpec: 1 | 2;
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
 * 计算某种模式下每行最多能放几个规格
 */
function calcMaxPerRow(counterLengthPx: number, packsPerSpec: number, gapCm: number): number {
  const gapPx = Math.max(Math.round(gapCm * PX_PER_CM), 0);
  const slotW = packsPerSpec * CELL_W + gapPx;
  return Math.max(1, Math.floor((counterLengthPx + gapPx) / slotW));
}

/**
 * 为单个柜台生成陈列图片
 *
 * 顶部 N 行是 zone 行(若有 zonePlacements):按 (priorityRank ASC, specCount DESC) 排,
 * 每个 zone 占用 rowCount 行,行内 packsPerSpec=1 紧贴排列,行最左侧画 12px 色条;
 * 剩余行用 layout(double/expanded/standard)绘制 regularSpecs。
 *
 * @param occurrenceCounts 全局 id→出现次数。double 模式下,count>1 的多选品规按勾选数量陈列(packsPerSpec=1),count=1 的单选品规按双包陈列(packsPerSpec=2)
 * @param zonePlacements 本柜台的专区落位列表(由 generate 路由按 counterId 筛选后传入)
 * @returns imageUrl 和消耗的 regular 品规数 usedCount(用于多柜台 offset)
 */
export async function generateCounterImage(
  counter: Counter,
  regularSpecs: Category[],
  layout: LayoutConfig = { mode: 'standard', gapCm: 0 },
  occurrenceCounts?: Map<string, number>,
  zonePlacements?: ZonePlacement[],
): Promise<{ imageUrl: string; usedCount: number }> {
  const canvasW = Math.round(counter.length * PX_PER_CM);
  const levels = counter.levels;

  if (canvasW <= 0 || levels <= 0) {
    throw new Error(`柜台 ${counter.id} 参数无效: length=${counter.length}, levels=${counter.levels}`);
  }

  const singleMaxPerRow = Math.floor(counter.length / PACK_WIDTH_CM);

  // ---- 1. 排序 zonePlacements,展开为 zone 行 ----
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
        packsPerSpec: 1,
      });
      off += want;
    }
  }

  const zoneRowCount = zoneRowSlots.length;
  const regularLevels = Math.max(0, levels - zoneRowCount);

  // ---- 2. 计算 regular 行布局 ----
  let regularRowLayouts: RegularRowSlot[];

  if (regularLevels === 0) {
    regularRowLayouts = [];
  } else if (layout.mode === 'double') {
    const doublePerRow = calcMaxPerRow(canvasW, 2, layout.gapCm);
    const doubleCapacity = doublePerRow * regularLevels;

    if (doubleCapacity >= regularSpecs.length) {
      const totalUsed = Math.min(doubleCapacity, regularSpecs.length);
      const perRow = staggeredDistribute(totalUsed, regularLevels);
      regularRowLayouts = perRow.map(n => ({ type: 'regular' as const, specCount: n, packsPerSpec: 2 as const }));
    } else {
      // 部分降级：底部若干行改为单包
      let numSingle = 1;
      while (
        numSingle < regularLevels &&
        doublePerRow * (regularLevels - numSingle) + singleMaxPerRow * numSingle < regularSpecs.length
      ) {
        numSingle++;
      }
      const doubleRowCount = regularLevels - numSingle;
      const specsInDouble = Math.min(doublePerRow * doubleRowCount, regularSpecs.length);
      const dPerRow = doubleRowCount > 0 ? staggeredDistribute(specsInDouble, doubleRowCount) : [];
      const specsInSingle = Math.min(regularSpecs.length - specsInDouble, singleMaxPerRow * numSingle);
      const sPerRow = staggeredDistribute(specsInSingle, numSingle);
      regularRowLayouts = [
        ...dPerRow.map(n => ({ type: 'regular' as const, specCount: n, packsPerSpec: 2 as const })),
        ...sPerRow.map(n => ({ type: 'regular' as const, specCount: n, packsPerSpec: 1 as const })),
      ];
    }
  } else {
    // expanded / standard：全部单包
    const maxPerRow = layout.mode === 'expanded'
      ? calcMaxPerRow(canvasW, 1, layout.gapCm)
      : singleMaxPerRow;
    const totalUsed = Math.min(maxPerRow * regularLevels, regularSpecs.length);
    const perRow = layout.mode === 'standard'
      ? uniformDistribute(totalUsed, regularLevels)
      : staggeredDistribute(totalUsed, regularLevels);
    regularRowLayouts = perRow.map(n => ({ type: 'regular' as const, specCount: n, packsPerSpec: 1 as const }));
  }

  const rowSlots: RowSlot[] = [...zoneRowSlots, ...regularRowLayouts];

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
  // double 模式下:多选品规(occurrenceCounts.get(id) > 1)按勾选数量陈列(packsPerSpec=1),单选品规仍按双包陈列。
  const getPacksForSpec = (spec: Category, rowDefault: number): number => {
    if (rowDefault === 2 && occurrenceCounts && (occurrenceCounts.get(spec.id) || 1) > 1) {
      return 1;
    }
    return rowDefault;
  };

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
    const specPacks = rowSpecs.map(s => getPacksForSpec(s, slot.packsPerSpec));

    let diffTransitions = 0;
    for (let i = 1; i < rowSpecs.length; i++) {
      if (rowSpecs[i].id !== rowSpecs[i - 1].id) diffTransitions++;
    }

    const totalPackW = specPacks.reduce((s, p) => s + p * CELL_W, 0);
    const gapBudget = Math.max(canvasW - totalPackW, 0);
    const interGap = diffTransitions > 0 ? gapBudget / diffTransitions : 0;
    const startX = diffTransitions > 0 ? 0 : (canvasW - totalPackW) / 2;

    let cursor = startX;
    for (let col = 0; col < rowSpecs.length; col++) {
      if (col > 0) {
        cursor += specPacks[col - 1] * CELL_W;
        if (rowSpecs[col].id !== rowSpecs[col - 1].id) cursor += interGap;
      }

      const imgPath = path.join(CATEGORY_IMG_ROOT, rowSpecs[col].imageUrl);
      const hasFile = fs.existsSync(imgPath);

      for (let p = 0; p < specPacks[col]; p++) {
        const x = cursor + p * CELL_W;
        if (hasFile) {
          try {
            const img = await loadImage(imgPath);
            ctx.drawImage(img, x, baseY, CELL_W, CELL_H);
          } catch {
            drawPlaceholder(ctx, rowSpecs[col].name, x, baseY, CELL_W, CELL_H);
          }
        } else {
          drawPlaceholder(ctx, rowSpecs[col].name, x, baseY, CELL_W, CELL_H);
        }
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
  for (let row = 0; row < zoneRowCount; row++) {
    const slot = rowSlots[row];
    if (slot.type !== 'zone') continue;
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
