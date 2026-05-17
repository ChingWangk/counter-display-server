import { Category } from '../../types';
import { sortCategories } from '../sortCategories';
import { categoryMap } from '../categoryCatalog';
import { SelectionContext, SelectionResult, StrategyFn } from './types';

/**
 * 自选规格：直接按用户勾选的 id 列表取品规，允许同一 id 重复出现（表示多包陈列）。
 * 不做紧俏烟过滤（manual 尊重用户选择）。
 */
export const manualStrategy: StrategyFn = async (ctx: SelectionContext): Promise<SelectionResult> => {
  const ids: string[] = ctx.requestCategories.map(c => c.id);
  const usedSpecIds = new Set(ids);
  const available = ids
    .map(id => categoryMap.get(id))
    .filter((c): c is Category => c !== undefined);

  const specs = sortCategories(available);
  return { specs, usedSpecIds };
};
