import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, loadImage, registerFont } from 'canvas';
import { Counter, Category, CounterResult, CounterType } from '../types';

const PACK_WIDTH_CM = 6; // 每包宽度 cm

// 每个格子的像素尺寸
const CELL_W = 120;
const CELL_H = 160;
const LABEL_H = 24; // 底部文字区域高度

// 图片输出目录（服务器上 Nginx 静态文件目录）
const OUTPUT_DIR = '/www/wwwroot/47.103.65.4/images/generated';

// 品类图片根目录
const CATEGORY_IMG_ROOT = '/www/wwwroot/47.103.65.4';

const COUNTER_TYPE_LABEL: Record<CounterType, string> = {
  front: '前柜',
  back: '背柜',
  corner: '转角柜',
};

/**
 * 为单个柜台生成陈列图片
 * @param counter 柜台参数
 * @param sorted 已排序的可放品规列表
 * @returns 图片 URL 路径（如 /images/generated/xxx.png）
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

  // 绘制网格线
  ctx.strokeStyle = '#D0C8B8';
  ctx.lineWidth = 1;
  for (let row = 0; row <= counter.levels; row++) {
    const y = row * CELL_H;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvasW, y);
    ctx.stroke();
  }
  for (let col = 0; col <= packsPerRow; col++) {
    const x = col * CELL_W;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvasH);
    ctx.stroke();
  }

  // 从左到右、从上到下填充品规图片
  for (let i = 0; i < placed.length; i++) {
    const row = Math.floor(i / packsPerRow);
    const col = i % packsPerRow;
    const x = col * CELL_W;
    const y = row * CELL_H;

    const cat = placed[i];

    // 尝试加载品类图片
    try {
      const imgPath = path.join(CATEGORY_IMG_ROOT, cat.imageUrl);
      if (fs.existsSync(imgPath)) {
        const img = await loadImage(imgPath);
        ctx.drawImage(img, x + 2, y + 2, CELL_W - 4, CELL_H - LABEL_H - 4);
      } else {
        // 图片不存在，绘制占位色块
        ctx.fillStyle = '#E8E0D0';
        ctx.fillRect(x + 2, y + 2, CELL_W - 4, CELL_H - LABEL_H - 4);
        ctx.fillStyle = '#999';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('无图', x + CELL_W / 2, y + (CELL_H - LABEL_H) / 2);
      }
    } catch {
      // 加载失败，绘制占位
      ctx.fillStyle = '#E8E0D0';
      ctx.fillRect(x + 2, y + 2, CELL_W - 4, CELL_H - LABEL_H - 4);
    }

    // 绘制品名
    ctx.fillStyle = '#333';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labelY = y + CELL_H - LABEL_H / 2;
    // 截断过长的名称
    let label = cat.name;
    if (ctx.measureText(label).width > CELL_W - 8) {
      while (label.length > 0 && ctx.measureText(label + '…').width > CELL_W - 8) {
        label = label.slice(0, -1);
      }
      label += '…';
    }
    ctx.fillText(label, x + CELL_W / 2, labelY);
  }

  // 空格子标记（如果品规不够填满）
  for (let i = placed.length; i < totalSlots; i++) {
    const row = Math.floor(i / packsPerRow);
    const col = i % packsPerRow;
    const x = col * CELL_W;
    const y = row * CELL_H;
    ctx.fillStyle = '#F0EBE0';
    ctx.fillRect(x + 2, y + 2, CELL_W - 4, CELL_H - 4);
    ctx.fillStyle = '#BBB';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('空位', x + CELL_W / 2, y + CELL_H / 2);
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
