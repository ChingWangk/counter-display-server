"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PACK_WIDTH_CM = void 0;
exports.generateCounterImage = generateCounterImage;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const canvas_1 = require("canvas");
// 注册中文字体:Linux 默认 fallback 字体(DejaVu/Liberation)无 CJK,
// 不注册会把 ctx.fillText 中的中文渲染为方块/乱码。逐个尝试常见路径,首个存在即注册。
// 服务器若未装字体,请运行:
//   CentOS:  yum install -y wqy-microhei-fonts && fc-cache -f
//   Ubuntu:  apt install -y fonts-wqy-microhei && fc-cache -f
// 也可通过 env CJK_FONT_PATH 显式指定字体文件路径。
const CJK_FONT_FAMILY = 'CounterCJK';
const CJK_FONT_CANDIDATES = [
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
    if (!fs.existsSync(fontPath))
        continue;
    try {
        (0, canvas_1.registerFont)(fontPath, { family: CJK_FONT_FAMILY });
        CJK_FONT_AVAILABLE = true;
        console.log(`[imageGen] CJK font registered: ${fontPath}`);
        break;
    }
    catch (err) {
        console.warn(`[imageGen] CJK font register failed: ${fontPath}`, err);
    }
}
if (!CJK_FONT_AVAILABLE) {
    console.warn('[imageGen] 未找到中文字体,陈列图上的中文将显示为方块。请安装 wqy-microhei-fonts (CentOS) 或 fonts-wqy-microhei (Ubuntu)。');
}
const FONT_FAMILY = CJK_FONT_AVAILABLE ? CJK_FONT_FAMILY : 'sans-serif';
const PACK_WIDTH_CM = 6; // 每包宽度 cm
exports.PACK_WIDTH_CM = PACK_WIDTH_CM;
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
const ZONE_LABEL_BAR_W = 4; // 标签左侧粗色条宽度
const ZONE_LABEL_FONT_SIZE = 18;
const ZONE_LABEL_LINE_H = 24; // 竖排每字垂直占位
// 分组专区组与组之间至少留出的空隙(像素)。
// bin-packing 时把此值计入下一组的占用宽度,避免组与组紧贴显得拥挤。
const MIN_INTER_GROUP_GAP_PX = CELL_W;
// 价签尺寸（贴在烟包底部）
const PRICE_TAG_H = 26;
const PRICE_TAG_FONT = `bold 16px ${FONT_FAMILY}`;
// 图片输出目录（服务器上 Nginx 静态文件目录）
const OUTPUT_DIR = '/www/wwwroot/47.103.65.4/images/generated';
// 品类图片根目录
const CATEGORY_IMG_ROOT = '/www/wwwroot/47.103.65.4';
/**
 * 绘制"未收录"占位图：灰底 + 商品名前三字 + "未收录"
 */
function drawPlaceholder(ctx, name, x, y, w, h) {
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
 * 绘制价签：贴在烟包底部的黄底红字"¥XX.X"小标签。
 * 仅当 spec_id 命中 priceTagMap 时调用,用于直接展示售价 < 杨浦区均价的规格。
 */
function drawPriceTag(ctx, price, x, y, w, h) {
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
function uniformDistribute(total, rows) {
    if (rows <= 0)
        return [];
    const base = Math.floor(total / rows);
    const extra = total % rows;
    return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}
/**
 * 交错分布：将 total 个规格分配到 rows 行
 * 把"多余"的行均匀散布，避免在两端集中，形成砖墙错位视觉
 */
function staggeredDistribute(total, rows) {
    if (rows <= 0)
        return [];
    const base = Math.floor(total / rows);
    const extra = total % rows;
    const result = new Array(rows).fill(base);
    if (extra === 0)
        return result;
    for (let i = 0; i < extra; i++) {
        const idx = Math.min(Math.floor((i + 0.5) * rows / extra), rows - 1);
        result[idx]++;
    }
    return result;
}
/**
 * 为单个柜台生成陈列图片
 *
 * 整张画布:左侧 ZONE_LABEL_W 宽的"专区标签栏" + 右侧陈列区域(width = counter.length × PX_PER_CM)。
 * 标签栏不挤占陈列容量(包数),仅在画布外侧延伸。常规行对应的标签栏区域为空白米白底。
 *
 * 行布局自上而下:
 *   层 0..regularRows-1: 常规陈列(单包,行内 staggered 分布;行内空隙由 canvas 均分)
 *   层 regularRows..regularRows+zoneRowCount-1: 功能专区(左侧标签栏画专区名,同专区跨多行合并为一条)
 *     - 单品专区(industrialCoop/slowMoving/newProduct):
 *       · industrialCoop / newProduct:自适应密度,稀疏时双包陈列,否则单包并保证至少 1 包宽 gap budget
 *       · slowMoving:始终单包,cap = packsPerRow - 1
 *     - 分组专区(substitute/nostalgia):primary + 每个 alternative 均单包陈列,
 *       组与组之间至少留 MIN_INTER_GROUP_GAP_PX 宽空隙
 *   层 regularRows+zoneRowCount..levels-1: 空闲层(仅画层板,不放品规)
 *
 * 单柜台多个 zone 按 (priorityRank ASC, groupCount DESC) 排序,每个占用 rowCount 行(已含 autoExpand)。
 *
 * @param regularRows 常规陈列实际占用的行数(由 generate 顺序分配后确定)
 * @param zonePlacements 本柜台的专区落位(rowCount 已经过 autoExpand 扩展)
 * @param priceTagMap spec_id → avg_price 映射;命中时在烟包底部画价签;缺省/空时不画
 */
async function generateCounterImage(counter, regularSpecs, regularRows, zonePlacements, priceTagMap) {
    const displayAreaW = Math.round(counter.length * PX_PER_CM);
    const canvasW = ZONE_LABEL_W + displayAreaW;
    const levels = counter.levels;
    if (canvasW <= 0 || levels <= 0) {
        throw new Error(`柜台 ${counter.id} 参数无效: length=${counter.length}, levels=${counter.levels}`);
    }
    const singleMaxPerRow = Math.floor(counter.length / PACK_WIDTH_CM);
    // ---- 1. 计算常规行布局(staggered 分布到 regularRows 行) ----
    const clampedRegularRows = Math.max(0, Math.min(regularRows, levels));
    let regularRowLayouts;
    if (clampedRegularRows === 0 || regularSpecs.length === 0) {
        regularRowLayouts = [];
    }
    else {
        const totalUsed = Math.min(singleMaxPerRow * clampedRegularRows, regularSpecs.length);
        const perRow = staggeredDistribute(totalUsed, clampedRegularRows);
        regularRowLayouts = perRow.map(n => ({ type: 'regular', specCount: n }));
    }
    // ---- 2. 排序 zonePlacements,展开为 zone 行 ----
    //   - 单品专区:把 groups 中所有 primary 拉平为 Category[],staggered 分布到 rowCount 行
    //   - 分组专区:整组不可拆,把 groups 按"行宽优先填满"分到 rowCount 行
    const sortedZones = (zonePlacements ?? [])
        .slice()
        .sort((a, b) => a.priorityRank - b.priorityRank || b.groupCount - a.groupCount);
    const zoneRowSlots = [];
    const zoneLabelBlocks = [];
    for (const zone of sortedZones) {
        const startRowInZone = zoneRowSlots.length;
        if (zone.displayMode === 'splitRows') {
            // splitRows(沪产专区):row1Specs / row2Specs 由 classifier 独立排序
            //   - rowCount=1 仅画 row1
            //   - rowCount=2 第一行 row1,第二行 row2
            //   - rowCount>=3 多出的行轮流 row1/row2(实际 autoExpand 通常给 1-2 行,极少触发)
            // 两排都启用自适应双包(用户决策:沪产烟与 industrialCoop/newProduct 一致的曝光语义)
            const splitGroups = zone.splitRowGroups;
            const row1Specs = splitGroups ? splitGroups.row1.map(g => g.primary) : [];
            const row2Specs = splitGroups ? splitGroups.row2.map(g => g.primary) : [];
            for (let r = 0; r < zone.rowCount; r++) {
                const sourceList = r % 2 === 0 ? row1Specs : row2Specs;
                let renderSpecs;
                if (sourceList.length > 0 && sourceList.length * 2 <= singleMaxPerRow) {
                    // 自适应双包:每个 spec 重复 2 次紧贴,drawFlatRow 会在 id 切换处自动留 gap
                    renderSpecs = sourceList.flatMap(s => [s, s]);
                }
                else {
                    const cap = Math.max(1, singleMaxPerRow - 1);
                    renderSpecs = sourceList.slice(0, cap);
                }
                zoneRowSlots.push({
                    type: 'zone-single',
                    specs: renderSpecs,
                });
            }
            zoneLabelBlocks.push({
                startRowInZone,
                rowCount: zone.rowCount,
                label: zone.label,
                barColor: zone.barColor,
            });
            continue;
        }
        if (zone.displayMode === 'single') {
            // 单品专区:拉平 groups 为 primary 列表,等同于旧的 specs
            const flatSpecs = zone.groups.map(g => g.primary);
            const perRow = uniformDistribute(flatSpecs.length, zone.rowCount);
            // 仅工商共育 / 新品尝鲜支持根据柜台余量自适应双包陈列;
            // 滞销夸夸角始终单包陈列(每个 spec 独立曝光,不强调"重复抢占"视觉效果)
            const canDoublePack = zone.zoneId === 'industrialCoop' || zone.zoneId === 'newProduct';
            let off = 0;
            for (let r = 0; r < zone.rowCount; r++) {
                const want = perRow[r];
                const rowSpecs = flatSpecs.slice(off, off + want);
                off += want;
                // 自适应密度,避免行内过于稀疏或过度拥挤:
                //  - 双包陈列(仅 industrialCoop / newProduct):specs * 2 <= packsPerRow,每个 spec 重复 2 次紧贴,
                //    drawFlatRow 会在 id 切换处自动留 gap
                //  - 单包陈列:cap = packsPerRow - 1,保证至少 1 包宽度的 gap budget,
                //    避免 specs 满行时 gap=0 出现"紧贴无缝"的拥挤观感
                let renderSpecs;
                if (canDoublePack && rowSpecs.length > 0 && rowSpecs.length * 2 <= singleMaxPerRow) {
                    renderSpecs = rowSpecs.flatMap(s => [s, s]);
                }
                else {
                    const cap = Math.max(1, singleMaxPerRow - 1);
                    renderSpecs = rowSpecs.slice(0, cap);
                }
                zoneRowSlots.push({
                    type: 'zone-single',
                    specs: renderSpecs,
                });
            }
        }
        else {
            // 分组专区:按行宽贪心分组,整组不可拆,超出本行行宽就换行
            //   primary 和每个 alternative 均占 1 包宽(单包陈列)
            //   一组宽度 = 1 + alts.length(2 个替代 → 3 包宽; 1 个替代 → 2 包宽,残缺组已排到末尾)
            //   组与组之间预留 MIN_INTER_GROUP_GAP_PX,bin-packing 时把它计入下一组占用
            const rowsOfGroups = [];
            let curRow = [];
            let curWidthPx = 0;
            for (const g of zone.groups) {
                const gWidthPx = (1 + g.alternatives.length) * CELL_W;
                if (gWidthPx > displayAreaW)
                    continue; // 一组都放不下整行,跳过
                const need = curRow.length === 0
                    ? gWidthPx
                    : curWidthPx + MIN_INTER_GROUP_GAP_PX + gWidthPx;
                if (need > displayAreaW) {
                    rowsOfGroups.push(curRow);
                    curRow = [g];
                    curWidthPx = gWidthPx;
                }
                else {
                    curRow.push(g);
                    curWidthPx = need;
                }
            }
            if (curRow.length > 0)
                rowsOfGroups.push(curRow);
            // 把 rowsOfGroups 映射到 zone.rowCount 行:
            //   - 若 rowsOfGroups.length <= rowCount:按顺序填,末行只画左侧 label(无陈列)
            //   - 若 > rowCount:超出部分丢弃(autoExpand 应该已给够行数,正常不会触发)
            for (let r = 0; r < zone.rowCount; r++) {
                zoneRowSlots.push({
                    type: 'zone-group',
                    groups: rowsOfGroups[r] ?? [],
                });
            }
        }
        zoneLabelBlocks.push({
            startRowInZone,
            rowCount: zone.rowCount,
            label: zone.label,
            barColor: zone.barColor,
        });
    }
    const zoneRowCount = zoneRowSlots.length;
    // 行槽:常规在上 → 专区紧贴其后 → 剩余为空闲层(slot 为 undefined)
    const rowSlots = new Array(levels).fill(undefined);
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
    const canvas = (0, canvas_1.createCanvas)(canvasW, canvasH);
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
        if (!slot)
            continue;
        const baseY = PADDING_TOP + row * (CELL_H + SHELF_BOARD_H);
        if (slot.type === 'zone-group') {
            await drawGroupedZoneRow(ctx, slot.groups, ZONE_LABEL_W, displayAreaW, baseY, priceTagMap);
            continue;
        }
        let rowSpecs;
        if (slot.type === 'zone-single') {
            rowSpecs = slot.specs;
        }
        else {
            rowSpecs = placedRegular.slice(regularIdx, regularIdx + slot.specCount);
            regularIdx += slot.specCount;
        }
        if (rowSpecs.length === 0)
            continue;
        await drawFlatRow(ctx, rowSpecs, ZONE_LABEL_W, displayAreaW, baseY, priceTagMap);
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
        const topRow = zoneStart + block.startRowInZone;
        if (topRow >= levels)
            continue;
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
 * 绘制扁平行(常规 + 单品专区):同 id 紧贴,按 id 切换处加 gap。
 * 烟包绘制于 [areaStartX, areaStartX + areaW] 区间内,左侧 areaStartX 留给专区标签栏。
 */
async function drawFlatRow(ctx, rowSpecs, areaStartX, areaW, baseY, priceTagMap) {
    let diffTransitions = 0;
    for (let i = 1; i < rowSpecs.length; i++) {
        if (rowSpecs[i].id !== rowSpecs[i - 1].id)
            diffTransitions++;
    }
    const totalPackW = rowSpecs.length * CELL_W;
    const gapBudget = Math.max(areaW - totalPackW, 0);
    const interGap = diffTransitions > 0 ? gapBudget / diffTransitions : 0;
    const startX = diffTransitions > 0
        ? areaStartX
        : areaStartX + (areaW - totalPackW) / 2;
    let cursor = startX;
    for (let col = 0; col < rowSpecs.length; col++) {
        if (col > 0) {
            cursor += CELL_W;
            if (rowSpecs[col].id !== rowSpecs[col - 1].id)
                cursor += interGap;
        }
        await drawSpec(ctx, rowSpecs[col], cursor, baseY, CELL_W, CELL_H, priceTagMap);
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
async function drawGroupedZoneRow(ctx, groups, areaStartX, areaW, baseY, priceTagMap) {
    if (groups.length === 0)
        return;
    const groupWidths = groups.map(g => (1 + g.alternatives.length) * CELL_W);
    const totalGroupW = groupWidths.reduce((s, w) => s + w, 0);
    const nGaps = groups.length - 1;
    const gapBudget = Math.max(areaW - totalGroupW, 0);
    let interGap;
    let startX;
    if (nGaps === 0) {
        interGap = 0;
        startX = areaStartX + (areaW - totalGroupW) / 2; // 单组居中
    }
    else {
        interGap = gapBudget / nGaps;
        startX = areaStartX;
    }
    let cursor = startX;
    for (let gi = 0; gi < groups.length; gi++) {
        if (gi > 0)
            cursor += interGap;
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
 * 绘制专区左侧说明标签:白底 + barColor 左侧粗色条 + barColor 竖排专区名,
 * 高度可跨多行(用于同专区 rowCount > 1 时合并为一条贯穿的 label)。
 */
function drawZoneLabel(ctx, x, y, w, h, label, barColor) {
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
async function drawSpec(ctx, spec, x, y, w, h, priceTagMap) {
    const imgPath = path.join(CATEGORY_IMG_ROOT, spec.imageUrl);
    const hasFile = fs.existsSync(imgPath);
    if (hasFile) {
        try {
            const img = await (0, canvas_1.loadImage)(imgPath);
            ctx.drawImage(img, x, y, w, h);
        }
        catch {
            drawPlaceholder(ctx, spec.name, x, y, w, h);
        }
    }
    else {
        drawPlaceholder(ctx, spec.name, x, y, w, h);
    }
    const price = priceTagMap?.get(spec.id);
    if (price !== undefined) {
        drawPriceTag(ctx, price, x, y, w, h);
    }
}
