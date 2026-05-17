import { newCustomerStrategy } from './newCustomerStrategy';
import { StrategyFn } from './types';

/**
 * 常规客户智能推荐（入网时间 ≥ 3 个月）。
 *
 * 演进路线（分步落地）：
 *  - 第 1 步【当前】：行为与新客户分支完全一致，直接复用 newCustomerStrategy，确保
 *    refactor 不引入回归。
 *  - 第 2 步【规划中】：把 customer_specs 查询替换为 cust_inventory 直查，并加入"是否
 *    脱销 / 是否滞销"的初步标记。
 *  - 第 3 步【规划中】：叠加专区策略（平替 / 价签 / 滞销夸夸 / 怀旧 / 尝鲜 / 节日 /
 *    沪产 / 短中细爆），通过前端"策略组合选择"页传入 zone_ids，按需挑选与排序。
 *
 * 隔离原则：本文件的任何变化都不应回流到 newCustomerStrategy；新增依赖（cust_inventory、
 * ref_co_purchase_rules 等）只在本模块内部使用。
 */
export const regularCustomerStrategy: StrategyFn = newCustomerStrategy;
