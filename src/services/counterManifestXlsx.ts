import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { ManifestRow } from './imageGen';

/** 与 imageGen 的 OUTPUT_DIR 同目录 —— Nginx 已把 /images/ 配为静态目录,
 *  放这里无需改任何服务器配置;xlsx 走同一条静态链路下发。 */
const OUTPUT_DIR = '/www/wwwroot/47.103.65.4/images/generated';

/** 一行最多列出多少格。超出的截断并在末列标注,避免个别超长柜台把表撑到几百列没法看。 */
const MAX_CELLS_PER_ROW = 60;

/**
 * 把一个柜台的陈列清单写成 .xlsx,返回可直接下载的 URL。
 *
 * 表结构(**每行 = 图上一层**,列自左向右 = 图上自左向右):
 *
 *   | 层 | 归属     | 第1包        | 第2包        | ... |
 *   | 1  | 工商共育 | 中华(细支5mg)[条+3包] | ...  |
 *   | 2  | 常规陈列 | 中华(硬)      | 中华(硬)      | ... |   ← 双包陈列,同规格连着两格
 *   | 5  | 空层     |              |              |     |
 *
 * 格内文本 = 规格名 + 可选备注(条+3包 / ★退市 / 正面·反面 / 产品升级(左) …),
 * 让店主拿着表就能一格一格对上图。规格 ID 不进表 —— 店主不认编码,认名字。
 *
 * 失败(目录不可写等)返回 null,由调用方静默降级为"不给导出按钮",绝不阻断出图。
 */
export function writeCounterManifestXlsx(
  manifest: ManifestRow[],
  opts: { counterId: string; counterLabel: string; customerId?: string },
): string | null {
  if (manifest.length === 0) return null;

  try {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const maxCells = Math.min(
      MAX_CELLS_PER_ROW,
      manifest.reduce((m, r) => Math.max(m, r.cells.length), 0),
    );

    // 用"格"而非"包":工商共育一格是「1条+3包」、尝鲜一个新品占正反两格,
    // 统一叫"格"才和图上自左向右数的位置一一对得上。
    const header = ['层', '归属'];
    for (let i = 0; i < maxCells; i++) header.push(`第${i + 1}格`);

    const aoa: (string | number)[][] = [header];
    for (const row of manifest) {
      const line: (string | number)[] = [row.rowIndex, row.section];
      for (let i = 0; i < maxCells; i++) {
        const c = row.cells[i];
        if (!c) { line.push(''); continue; }
        line.push(c.note ? `${c.specName}【${c.note}】` : c.specName);
      }
      if (row.cells.length > maxCells) {
        line[line.length - 1] = `${line[line.length - 1]}（后续 ${row.cells.length - maxCells} 包略）`;
      }
      aoa.push(line);
    }

    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    // 列宽:层号窄、归属中等、包名列统一给足,免得店主还要手动拉列宽
    sheet['!cols'] = [{ wch: 5 }, { wch: 12 }, ...Array.from({ length: maxCells }, () => ({ wch: 22 }))];

    const book = XLSX.utils.book_new();
    // 工作表名不能含 : \ / ? * [ ] 且 ≤31 字符
    XLSX.utils.book_append_sheet(book, sheet, opts.counterLabel.replace(/[:\\/?*[\]]/g, '').slice(0, 31) || '柜台规格');

    const stamp = Date.now();
    const safeCustomer = (opts.customerId || 'x').replace(/[^0-9A-Za-z_-]/g, '');
    const filename = `manifest_${safeCustomer}_${opts.counterId}_${stamp}.xlsx`;
    XLSX.writeFile(book, path.join(OUTPUT_DIR, filename));

    return `/images/generated/${filename}`;
  } catch (err) {
    console.error('[counterManifest] 写 xlsx 失败,本柜台不下发导出链接:', err);
    return null;
  }
}
