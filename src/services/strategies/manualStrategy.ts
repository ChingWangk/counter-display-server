import { Category } from '../../types';
import { sortCategories } from '../sortCategories';
import { getExtendedCategoryMap } from '../categoryCatalog';
import { classifyZones, buildZonePlacements, buildInlinePairs, resolveIndustrialCoopUnits } from './zones';
import { SelectionContext, SelectionResult, StrategyFn, ZoneId } from './types';

/**
 * 自选规格：直接按用户勾选的 id 列表取品规，允许同一 id 重复出现（表示多包陈列）。
 * 不做紧俏烟过滤（manual 尊重用户选择）。
 *
 * 专区支持:若 ctx.zoneAssignments 非空,按 classifyZones 命中结果落位 zonePlacements。
 * 注意:zone specs 同时保留在常规陈列区,不再从 sorted 中扣除——同一规格会在 zone 行
 * (带色条)与常规行各出现一次。manual 模式无 inventory:
 *  - 滞销专区会自然返回 [](无库存数据)
 *  - 平替专区也返回 [](manual 模式不查 ref_co_purchase_rules,无脱销源)
 *  - 工商共育 / 怀旧 / 尝鲜 依然可用,nostalgia 依赖 successor 是否在用户已选规格内
 */
export const manualStrategy: StrategyFn = async (ctx: SelectionContext): Promise<SelectionResult> => {
  const ids: string[] = ctx.requestCategories.map(c => c.id);
  const usedSpecIds = new Set(ids);

  // 使用扩展版 categoryMap,以便 classifyZones 拿到 is_industrial_coop / is_delisted / launch_date / tier
  const extendedCategoryMap = await getExtendedCategoryMap();
  const available = ids
    .map(id => extendedCategoryMap.get(id))
    .filter((c): c is Category => c !== undefined);

  const sorted = sortCategories(available);

  // 专区分类 + 按 zoneAssignments 落位(仅 zoneRows 专区);基础版三专区走专属字段。
  // manual 模式无 inventory:substitute 因无 rules 基本为空;productUpgrade 走通用规则需副规格在所选集合内;
  // industrialCoop 仍可按固定 4 单元渲染(占位偏多)。
  if (ctx.zoneAssignments && ctx.zoneAssignments.length > 0) {
    const customerOnSaleIds = new Set(sorted.map(c => c.id));
    const classification = classifyZones(sorted, extendedCategoryMap, customerOnSaleIds);
    const zonePlacements = buildZonePlacements(
      classification,
      ctx.zoneAssignments,
      sorted,
      extendedCategoryMap,
    );
    const enabledZoneIds = new Set<ZoneId>(ctx.zoneAssignments.map(a => a.zone_id));
    const industrialCoopUnits = enabledZoneIds.has('industrialCoop')
      ? resolveIndustrialCoopUnits(sorted, extendedCategoryMap)
      : undefined;
    const inlinePairs = buildInlinePairs(classification, extendedCategoryMap, enabledZoneIds);
    return { specs: sorted, usedSpecIds, zonePlacements, industrialCoopUnits, inlinePairs };
  }

  return { specs: sorted, usedSpecIds };
};
