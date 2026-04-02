import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, loadImage } from 'canvas';
import { Counter, Category, CounterResult, CounterType } from '../types';

const PACK_WIDTH_CM = 6; // 每包宽度 cm

// 每个格子的像素尺寸
const CELL_W = 120;
const CELL_H = 160;

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

  // 画布尺寸
  const canvasW = packsPerRow * CELL_W;
  const canvasH = counter.levels * CELL_H;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  // 背景色
  ctx.fillStyle = '#F5F0E8';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // 从左到右、从上到下填充品规图片
  for (let i = 0; i < placed.length; i++) {
    const row = Math.floor(i / packsPerRow);
    const col = i % packsPerRow;
    const x = col * CELL_W;
    const y = row * CELL_H;

    const imgPath = path.join(CATEGORY_IMG_ROOT, placed[i].imageUrl);
    try {
      const img = await loadImage(imgPath);
      ctx.drawImage(img, x, y, CELL_W, CELL_H);
    } catch {
      // 不应该走到这里（已经预过滤了），但保底画空格
      ctx.fillStyle = '#E8E0D0';
      ctx.fillRect(x, y, CELL_W, CELL_H);
    }
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