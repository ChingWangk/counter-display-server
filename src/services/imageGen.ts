import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, loadImage } from 'canvas';
import { Counter, Category, LayoutConfig } from '../types';

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

// 图片输出目录（服务器上 Nginx 静态文件目录）
const OUTPUT_DIR = '/www/wwwroot/47.103.65.4/images/generated';

// 品类图片根目录
const CATEGORY_IMG_ROOT = '/www/wwwroot/47.103.65.4';

// ---- 每行布局描述 ----
interface RowLayout {
  specCount: number;     // 该行放几个规格
  packsPerSpec: number;  // 1（单包）或 2（双包）
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
 *
 * 示例：
 *   31/4 → [8, 8, 8, 7]
 *   30/4 → [8, 8, 7, 7]
 *   32/4 → [8, 8, 8, 8]
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
 *
 * 示例：
 *   35/4 → [9, 8, 9, 9]（thin row 在中间偏上，相邻行数量不同）
 *   34/4 → [8, 9, 8, 9]（完美交替）
 *   33/4 → [8, 8, 9, 8]（long row 在中间）
 *   36/4 → [9, 9, 9, 9]（正好整除）
 */
function staggeredDistribute(total: number, rows: number): number[] {
  if (rows <= 0) return [];
  const base = Math.floor(total / rows);
  const extra = total % rows;
  const result: number[] = new Array(rows).fill(base);

  if (extra === 0) return result;

  // 把 extra 个 +1 位置均匀散布：第 i 个 +1 放在 floor((i + 0.5) * rows / extra)
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
 * @param occurrenceCounts 全局 id→出现次数。double 模式下，count>1 的多选品规按勾选数量陈列（packsPerSpec=1），count=1 的单选品规按双包陈列（packsPerSpec=2）
 * @returns imageUrl 和消耗的品规数 usedCount（用于多柜台去重）
 */
export async function generateCounterImage(
  counter: Counter,
  sorted: Category[],
  layout: LayoutConfig = { mode: 'standard', gapCm: 0 },
  occurrenceCounts?: Map<string, number>,
): Promise<{ imageUrl: string; usedCount: number }> {
  const canvasW = Math.round(counter.length * PX_PER_CM);
  const levels = counter.levels;

  if (canvasW <= 0 || levels <= 0) {
    throw new Error(`柜台 ${counter.id} 参数无效: length=${counter.length}, levels=${counter.levels}`);
  }

  const singleMaxPerRow = Math.floor(counter.length / PACK_WIDTH_CM);

  // ---- 确定每行布局 ----
  let rowLayouts: RowLayout[];

  if (layout.mode === 'double') {
    const doublePerRow = calcMaxPerRow(canvasW, 2, layout.gapCm);
    const doubleCapacity = doublePerRow * levels;

    if (doubleCapacity >= sorted.length) {
      // 全部双包，交错分布
      const totalUsed = Math.min(doubleCapacity, sorted.length);
      const perRow = staggeredDistribute(totalUsed, levels);
      rowLayouts = perRow.map(n => ({ specCount: n, packsPerSpec: 2 }));
    } else {
      // 部分降级：从底部开始将若干行改为单包
      let numSingle = 1;
      while (
        numSingle < levels &&
        doublePerRow * (levels - numSingle) + singleMaxPerRow * numSingle < sorted.length
      ) {
        numSingle++;
      }
      const doubleRowCount = levels - numSingle;

      // 双包行分配
      const specsInDouble = Math.min(doublePerRow * doubleRowCount, sorted.length);
      const dPerRow = doubleRowCount > 0 ? staggeredDistribute(specsInDouble, doubleRowCount) : [];

      // 单包行分配（剩余规格）
      const specsInSingle = Math.min(sorted.length - specsInDouble, singleMaxPerRow * numSingle);
      const sPerRow = staggeredDistribute(specsInSingle, numSingle);

      rowLayouts = [
        ...dPerRow.map(n => ({ specCount: n, packsPerSpec: 2 })),
        ...sPerRow.map(n => ({ specCount: n, packsPerSpec: 1 })),
      ];
    }

  } else {
    // expanded / standard：全部单包
    const maxPerRow = layout.mode === 'expanded'
      ? calcMaxPerRow(canvasW, 1, layout.gapCm)
      : singleMaxPerRow;
    const totalUsed = Math.min(maxPerRow * levels, sorted.length);
    // standard（资源匮乏）用均匀分布，expanded 用交错分布
    const perRow = layout.mode === 'standard'
      ? uniformDistribute(totalUsed, levels)
      : staggeredDistribute(totalUsed, levels);
    rowLayouts = perRow.map(n => ({ specCount: n, packsPerSpec: 1 }));
  }

  // ---- 汇总实际使用的规格数 ----
  const usedCount = rowLayouts.reduce((s, r) => s + r.specCount, 0);
  const placed = sorted.slice(0, usedCount);

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
  // 规则：同 id 品规在行内紧贴（无缝）；
  //      首包贴左边 (x=0)、末包右边贴 canvasW，行间首末严格对齐；
  //      剩余空间均分到"不同 id 之间"的间隔上，避免同 id 压缩导致的视觉缩进。
  //      行内全为同 id 或仅 1 个品规时（极端情况）退化为居中。
  // double 模式下：多选品规（occurrenceCounts.get(id) > 1）按勾选数量陈列（packsPerSpec=1），
  //                单选品规仍按双包陈列（packsPerSpec=2）。
  const getPacksForSpec = (spec: Category, rowDefault: number): number => {
    if (rowDefault === 2 && occurrenceCounts && (occurrenceCounts.get(spec.id) || 1) > 1) {
      return 1;
    }
    return rowDefault;
  };

  let specIdx = 0;
  for (let row = 0; row < levels; row++) {
    const rl = rowLayouts[row];
    if (rl.specCount === 0) continue;

    const baseY = PADDING_TOP + row * (CELL_H + SHELF_BOARD_H);

    // 本行的品规切片
    const rowSpecs = placed.slice(specIdx, specIdx + rl.specCount);
    // 行内每个品规的实际包数（双包模式下多选品规返回 1，否则按 rl.packsPerSpec）
    const specPacks = rowSpecs.map(s => getPacksForSpec(s, rl.packsPerSpec));

    // 统计行内"不同 id 之间"的过渡数（同 id 不计）
    let diffTransitions = 0;
    for (let i = 1; i < rowSpecs.length; i++) {
      if (rowSpecs[i].id !== rowSpecs[i - 1].id) diffTransitions++;
    }

    const totalPackW = specPacks.reduce((s, p) => s + p * CELL_W, 0);
    const gapBudget = Math.max(canvasW - totalPackW, 0);
    // 不同 id 之间均分剩余空间；行内全部同 id 时退化为居中
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

    specIdx += rl.specCount;
  }

  // ---- 绘制层板 ----
  for (let r = 0; r < shelfBoards; r++) {
    const boardY = PADDING_TOP + (r + 1) * CELL_H + r * SHELF_BOARD_H;
    ctx.fillStyle = SHELF_BOARD_COLOR;
    ctx.fillRect(0, boardY, canvasW, SHELF_BOARD_H);
    ctx.fillStyle = SHELF_BOARD_SHADOW;
    ctx.fillRect(0, boardY + SHELF_BOARD_H - 2, canvasW, 2);
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
