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

/**
 * 过滤掉服务器上没有图片文件的品规
 */
export function filterWithImages(categories: Category[]): Category[] {
  return categories.filter(c => {
    const imgPath = path.join(CATEGORY_IMG_ROOT, c.imageUrl);
    return fs.existsSync(imgPath);
  });
}

/**
 * 为单个柜台生成陈列图片
 * @returns imageUrl 和消耗的品规数 usedCount（用于多柜台去重）
 */
export async function generateCounterImage(
  counter: Counter,
  sorted: Category[],
  layout: LayoutConfig = { mode: 'standard', gapCm: 0 }
): Promise<{ imageUrl: string; usedCount: number }> {
  // ---- 根据布局模式计算每行放几个规格 ----
  let specsPerRow: number;
  let packsPerSpec: number; // 每个规格放几包
  let gapPx: number;       // 规格间像素间隙

  if (layout.mode === 'double') {
    packsPerSpec = 2;
    gapPx = Math.max(Math.round(layout.gapCm * PX_PER_CM), 0);
    const slotW = packsPerSpec * CELL_W + gapPx;
    specsPerRow = Math.max(1, Math.floor((counter.length * PX_PER_CM + gapPx) / slotW));
  } else if (layout.mode === 'expanded') {
    packsPerSpec = 1;
    gapPx = Math.max(Math.round(layout.gapCm * PX_PER_CM), 0);
    const slotW = CELL_W + gapPx;
    specsPerRow = Math.max(1, Math.floor((counter.length * PX_PER_CM + gapPx) / slotW));
  } else {
    // standard：原有逻辑——紧排，间隙由填充率决定
    packsPerSpec = 1;
    gapPx = 0; // 后面单独计算
    specsPerRow = Math.floor(counter.length / PACK_WIDTH_CM);
  }

  if (specsPerRow <= 0 || counter.levels <= 0) {
    throw new Error(`柜台 ${counter.id} 参数无效: length=${counter.length}, levels=${counter.levels}`);
  }

  const totalSpecSlots = specsPerRow * counter.levels;
  const usedCount = Math.min(totalSpecSlots, sorted.length);
  const placed = sorted.slice(0, usedCount);

  // ---- standard 模式：保留原有的动态间隙计算 ----
  if (layout.mode === 'standard') {
    const fillRatio = placed.length / totalSpecSlots;
    const MAX_GAP = Math.floor(CELL_W / 4);
    gapPx = Math.round(MAX_GAP * (1 - fillRatio));
  }

  // ---- 画布尺寸 ----
  const slotW = packsPerSpec * CELL_W + gapPx;
  const canvasW = specsPerRow * slotW;
  const shelfBoards = counter.levels - 1;
  const PADDING_TOP = 2;
  const canvasH = counter.levels * CELL_H + shelfBoards * SHELF_BOARD_H + PADDING_TOP * 2;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  // 背景色
  ctx.fillStyle = '#F5F0E8';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // ---- 填充品规图片 ----
  for (let i = 0; i < placed.length; i++) {
    const row = Math.floor(i / specsPerRow);
    const col = i % specsPerRow;
    const baseX = col * slotW;
    const baseY = PADDING_TOP + row * (CELL_H + SHELF_BOARD_H);

    const imgPath = path.join(CATEGORY_IMG_ROOT, placed[i].imageUrl);

    // 绘制 packsPerSpec 包
    for (let p = 0; p < packsPerSpec; p++) {
      const x = baseX + p * CELL_W;
      try {
        const img = await loadImage(imgPath);
        ctx.drawImage(img, x, baseY, CELL_W, CELL_H);
      } catch {
        ctx.fillStyle = '#E8E0D0';
        ctx.fillRect(x, baseY, CELL_W, CELL_H);
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
