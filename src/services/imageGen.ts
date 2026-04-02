import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, loadImage } from 'canvas';
import { Counter, Category, CounterResult, CounterType } from '../types';

const PACK_WIDTH_CM = 6; // 每包宽度 cm

// 每个格子的基础像素尺寸（烟包图片）
const CELL_W = 120;
const CELL_H = 160;

// 层板（横木）高度
const SHELF_BOARD_H = 12;
// 层板颜色（木色）
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
 * 为单个柜台生成陈列图片（纯拼图，无文字）
 */
export async function generateCounterImage(
  counter: Counter,
  sorted: Category[]
): Promise<string> {
  const packsPerRow = Math.floor(counter.length / PACK_WIDTH_CM);
  const totalSlots = packsPerRow * counter.levels;

  if (packsPerRow <= 0 || counter.levels <= 0) {
    throw new Error(`柜台 ${counter.id} 参数无效: length=${counter.length}, levels=${counter.levels}`);
  }

  // 取前 totalSlots 个品规
  const placed = sorted.slice(0, totalSlots);

  // 计算包与包之间的间隙
  // 填充率 = 实际品规数 / 总格子数
  const fillRatio = placed.length / totalSlots;
  // 间隙上限：烟包宽度的 1/4
  const MAX_GAP = Math.floor(CELL_W / 4);
  // 填充率越高间隙越小：100%填充→0间隙，低填充→最大间隙
  const gap = Math.round(MAX_GAP * (1 - fillRatio));

  // 画布尺寸：考虑间隙和层板
  const canvasW = packsPerRow * CELL_W + (packsPerRow + 1) * gap;
  const shelfBoards = counter.levels - 1; // 层板数 = 层数 - 1（顶层上方无板）
  const canvasH = counter.levels * CELL_H + shelfBoards * SHELF_BOARD_H + (counter.levels * 2 + 2) * 1; // 上下留一点边距
  const PADDING_TOP = 2;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  // 背景色（柜台内部）
  ctx.fillStyle = '#F5F0E8';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // 从左到右、从上到下填充品规图片
  for (let i = 0; i < placed.length; i++) {
    const row = Math.floor(i / packsPerRow);
    const col = i % packsPerRow;
    // x: 左边距gap + col*(格子宽+间隙)
    const x = gap + col * (CELL_W + gap);
    // y: 顶部边距 + row*(格子高+层板高)
    const y = PADDING_TOP + row * (CELL_H + SHELF_BOARD_H);

    const imgPath = path.join(CATEGORY_IMG_ROOT, placed[i].imageUrl);
    try {
      const img = await loadImage(imgPath);
      ctx.drawImage(img, x, y, CELL_W, CELL_H);
    } catch {
      ctx.fillStyle = '#E8E0D0';
      ctx.fillRect(x, y, CELL_W, CELL_H);
    }
  }

  // 绘制层板（横木），在每层之间
  for (let r = 0; r < shelfBoards; r++) {
    const boardY = PADDING_TOP + (r + 1) * CELL_H + r * SHELF_BOARD_H;
    // 层板主体
    ctx.fillStyle = SHELF_BOARD_COLOR;
    ctx.fillRect(0, boardY, canvasW, SHELF_BOARD_H);
    // 底部阴影线
    ctx.fillStyle = SHELF_BOARD_SHADOW;
    ctx.fillRect(0, boardY + SHELF_BOARD_H - 2, canvasW, 2);
  }

  // 确保输出目录存在
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 保存文件
  const filename = `counter_${counter.id}_${Date.now()}.png`;
  const outputPath = path.join(OUTPUT_DIR, filename);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);

  return `/images/generated/${filename}`;
}