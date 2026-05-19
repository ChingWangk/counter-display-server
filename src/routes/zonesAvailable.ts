import { Router, Request, Response } from 'express';
import { RowDataPacket } from 'mysql2';
import pool from '../db';
import { Category } from '../types';
import { getExtendedCategoryMap } from '../services/categoryCatalog';
import { classifyZones } from '../services/strategies/zones';
import {
  AvailableZone,
  SpecInventoryInfo,
  ZONE_META,
  ZONE_PRIORITY_ORDER,
  ZoneClassification,
  ZoneId,
} from '../services/strategies/types';

/**
 * POST /api/zones/available
 *
 * 在用户进入 zone-select 页面时调用,返回当前模式下可用的专区清单(含品规数)。
 * 前端用此结果展示专区卡片,用户选启用/分配,然后调 /api/generate。
 *
 * - smart 模式:从 cust_inventory 拉客户在售品规
 * - manual 模式:用前端传入的 categories
 * 然后通过 getExtendedCategoryMap 合并 ext 字段,classifyZones 已带优先级 dedupe。
 */

interface InventoryRow extends RowDataPacket {
  spec_id: string;
  stock_qty: number;
  stock_days: number;
  snapshot_date: string | Date;
}

interface RequestBody {
  customer_id?: string;
  categories?: { id: string }[];
  mode: 'smart' | 'manual';
}

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const { customer_id, categories, mode } = (req.body || {}) as RequestBody;

    if (mode !== 'smart' && mode !== 'manual') {
      res.status(400).json({ success: false, error: 'mode 必须为 smart 或 manual' });
      return;
    }

    // ---- 1. 准备 source spec 列表 + inventory ----
    const extendedMap = await getExtendedCategoryMap();
    let sourceSpecs: Category[] = [];
    let inventoryById: Map<string, SpecInventoryInfo> = new Map();

    if (mode === 'smart') {
      if (!customer_id) {
        res.status(400).json({ success: false, error: 'smart 模式需要 customer_id' });
        return;
      }
      const [rows] = await pool.execute<InventoryRow[]>(
        `
        SELECT t.spec_id, t.stock_qty, t.stock_days, t.snapshot_date
        FROM cust_inventory t
        INNER JOIN (
          SELECT spec_id, MAX(snapshot_date) AS max_date
          FROM cust_inventory
          WHERE customer_id = ?
          GROUP BY spec_id
        ) m ON t.spec_id = m.spec_id AND t.snapshot_date = m.max_date
        WHERE t.customer_id = ?
        `,
        [customer_id, customer_id]
      );
      for (const r of rows) {
        const snapshotStr = r.snapshot_date instanceof Date
          ? r.snapshot_date.toISOString().slice(0, 10)
          : String(r.snapshot_date).slice(0, 10);
        inventoryById.set(r.spec_id, {
          spec_id: r.spec_id,
          stock_qty: Number(r.stock_qty),
          stock_days: Number(r.stock_days),
          snapshot_date: snapshotStr,
        });
        const c = extendedMap.get(r.spec_id);
        if (c) sourceSpecs.push(c);
      }
    } else {
      // manual:用前端传入的 categories(只需要 id),通过 extendedMap 合并 ext 字段
      if (!Array.isArray(categories) || categories.length === 0) {
        res.json({ success: true, zones: [], customerSpecCount: 0 });
        return;
      }
      // 去重 id,manual 模式同一品类可能被多次选中
      const uniqueIds = Array.from(new Set(categories.map(c => c.id)));
      for (const id of uniqueIds) {
        const c = extendedMap.get(id);
        if (c) sourceSpecs.push(c);
      }
    }

    // 客户总品规数(用于前端计算每柜台最多可分配的专区行数):
    // smart 模式 = cust_inventory 去重 spec 数; manual 模式 = 用户勾选总数(含重复,即陈列包数)
    const customerSpecCount = mode === 'smart'
      ? sourceSpecs.length
      : (categories?.length ?? 0);

    // ---- 2. 分类 + dedupe ----
    const zoneCls: ZoneClassification = classifyZones(sourceSpecs, inventoryById);

    // ---- 3. 转换为 AvailableZone[],只保留 specCount > 0 ----
    const result: AvailableZone[] = [];
    for (const zoneId of ZONE_PRIORITY_ORDER) {
      const specs = zoneCls[zoneId as keyof ZoneClassification];
      if (specs.length === 0) continue;
      result.push({
        ...ZONE_META[zoneId as ZoneId],
        specCount: specs.length,
        specs,
      });
    }

    res.json({ success: true, zones: result, customerSpecCount });
  } catch (err) {
    console.error('zones/available error:', err);
    const message = err instanceof Error ? err.message : '获取专区失败';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
