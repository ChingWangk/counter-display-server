import { Router, Request, Response } from 'express';
import { RowDataPacket } from 'mysql2';
import pool from '../db';
import { Category } from '../types';
import { getExtendedCategoryMap } from '../services/categoryCatalog';
import { classifyZones } from '../services/strategies/zones';
import { fetchSubstituteRules, getCustomerHasPos, fetchRecentStockoutFreq } from '../services/strategies/substitute';
import { getCustomerClass } from '../services/customerClass';
import { computeInlinePairs } from '../services/strategies/inlinePairs';
import { hasFestivalCandidates } from '../services/strategies/festivalSeason';
import {
  AvailableZone,
  SpecInventoryInfo,
  ZONE_META,
  ZONE_PRIORITY_ORDER,
  ZoneClassification,
  ZoneGroup,
  ZoneId,
  ZoneSpec,
} from '../services/strategies/types';

/**
 * POST /api/zones/available
 *
 * 在用户进入 zone-select 页面时调用,返回当前模式下可用的专区清单(含组数/规格数)。
 * 前端用此结果展示专区卡片,用户选启用/分配,然后调 /api/generate。
 *
 * - smart 模式:从 cust_inventory 拉客户在售品规
 * - manual 模式:用前端传入的 categories
 * 然后通过 getExtendedCategoryMap 合并 ext 字段,classifyZones 各专区独立计算。
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

    // ---- 2. 拉平替候选 spec_id_a→spec_id_b[] 映射（仅 smart + 有 customer_id 时生效）----
    let substituteRules = new Map<string, string[]>();
    // 平替脱销判定:POS 客户用近一周脱销集+季度频次,与 /api/generate 同源;非 POS/表未就绪 → undefined 回退 stock_qty==0。
    let recentStockoutFreq: Map<string, number> | null | undefined;
    if (mode === 'smart' && customer_id) {
      const hasPos = await getCustomerHasPos(customer_id);
      substituteRules = await fetchSubstituteRules(customer_id, hasPos);
      if (hasPos) recentStockoutFreq = await fetchRecentStockoutFreq(customer_id);
    }

    // ---- 3. 分类 ----
    // customerOnSaleIds 仅含 stock_qty > 0 的规格,与 regularCustomerStrategy 保持一致:
    // 刚好脱销(stock_qty=0)的品规不能作为他人的替代/继任,避免推荐"也缺货"的规格,
    // 否则 zone-select 列出的 nostalgia/substitute/productUpgrade 在 /api/generate 二次分类时
    // 会因 alternatives 在售校验失败被丢弃,前端看不到对应的色条/chip。
    // manual 模式无 inventory,fallback 为全集(等同 stock_qty 视为正)。
    const customerOnSaleIds = new Set(
      mode === 'smart'
        ? sourceSpecs
            .filter(c => (inventoryById.get(c.id)?.stock_qty ?? 0) > 0)
            .map(c => c.id)
        : sourceSpecs.map(c => c.id),
    );
    const zoneCls: ZoneClassification = classifyZones(
      sourceSpecs,
      extendedMap,
      customerOnSaleIds,
      inventoryById,
      substituteRules,
    );

    // 产品升级 / 平替为 inlineRegular(纯开关)专区:可用性按「内嵌红框配对数」判定,
    // 而非 classifyZones 的旧 grouped 结果(两者口径不同)。computeInlinePairs 与 /api/generate 同源,
    // 保证 zone-select 列出开关 ⇔ 生成时确有红框可画。
    // 注:此处不传 customerId → 不套用 UPGRADE_PAIR_CAP_BY_CUSTOMER 封顶(仅 116314785),
    // 生成时才封顶。封顶下限 ≥ 1,裁后仍 >0,不影响"开关是否出现"的判定,故无碍。
    const upgradePairCount = computeInlinePairs({
      specs: sourceSpecs, enableUpgrade: true, enableSubstitute: false,
      extendedMap, onSaleIds: customerOnSaleIds, inventoryById,
    }).size;
    const substitutePairCount = computeInlinePairs({
      specs: sourceSpecs, enableUpgrade: false, enableSubstitute: true,
      extendedMap, onSaleIds: customerOnSaleIds, inventoryById, recentStockoutFreq,
    }).size;

    // ---- 4. 转换为 AvailableZone[],只保留 groupCount > 0 ----
    const result: AvailableZone[] = [];
    for (const zoneId of ZONE_PRIORITY_ORDER) {
      const meta = ZONE_META[zoneId as ZoneId];
      if (meta.layoutKind === 'inlineRegular') {
        // 产品升级/平替:纯开关专区,可用性=内嵌配对数(>0 才展示开关);groupCount 前端不显示
        const cnt = zoneId === 'productUpgrade' ? upgradePairCount : substitutePairCount;
        if (cnt === 0) continue;
        result.push({ ...meta, groupCount: cnt, specs: [] });
        continue;
      }
      if (meta.displayMode === 'backFestival') {
        // 节日季节专区:数据流与其他 zone 完全隔离,这里仅判定"是否有图片素材且客户至少 1 张候选"
        if (!hasFestivalCandidates(customerOnSaleIds)) continue;
        result.push({
          ...meta,
          groupCount: 1,  // 占位 — 实际按节日单图直出,前端 zone-select 不依赖此数
          specs: [],
        });
        continue;
      }
      // 走 classification 表查询:此分支下 zoneId 必属于 ZoneClassification 单品/分组字段。
      // productUpgrade(inlineRegular,上方已 continue)与 priceTag(纯开关,不在 ZONE_PRIORITY_ORDER)
      // 均不属 ZoneClassification,排除以对齐键集。
      const clsKey = zoneId as Exclude<ZoneId, 'festivalSeason' | 'priceTag' | 'productUpgrade'>;
      if (meta.displayMode === 'single') {
        const specs = zoneCls[clsKey] as ZoneSpec[];
        if (specs.length === 0) continue;
        result.push({
          ...meta,
          groupCount: specs.length,
          specs,
        });
      } else {
        // grouped(含 keyRecommend:滞销单品组 alternatives=[] 也计入 groupCount)
        const groups = zoneCls[clsKey] as ZoneGroup[];
        if (groups.length === 0) continue;
        result.push({
          ...meta,
          groupCount: groups.length,
          specs: groups.map(g => g.primary),  // 卡片预览用 primary 列表
          groups,
        });
      }
    }

    // ---- 5. 价签体检(priceTag):纯开关型专区,不进上面的落位循环,这里单独插入 ----
    // 口径:常规客户(非新客户)总是显示该开关(不预判有无偏低规格);勾选后由 /api/generate 决定
    // 真正贴不贴价签(有偏低才贴)。价签基于客户成交价对比,新客户/无 customer_id 不适用。
    // 位置:排在所有基础版专区之后、第一个进阶版专区(如重点推荐区)之前,让基础版专区聚在一起。
    if (customer_id) {
      const cls = await getCustomerClass(customer_id);
      if (cls === 'regular') {
        const priceTagZone: AvailableZone = { ...ZONE_META.priceTag, groupCount: 1, specs: [] };
        const firstAdvancedIdx = result.findIndex(z => z.tier === 'advanced');
        if (firstAdvancedIdx === -1) result.push(priceTagZone);
        else result.splice(firstAdvancedIdx, 0, priceTagZone);
      }
    }

    res.json({ success: true, zones: result, customerSpecCount });
  } catch (err) {
    console.error('zones/available error:', err);
    const message = err instanceof Error ? err.message : '获取专区失败';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
