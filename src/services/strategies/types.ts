import { Category } from '../../types';

/** 选品策略的输入上下文，由路由层基于请求体计算后传入。 */
export interface SelectionContext {
  /** 客户编号；manual 模式可为空，smart 模式必填（在策略内部校验） */
  customerId?: string;
  /** 前柜 + 吊柜的总容量（包数） */
  totalSlots: number;
  /** 前柜 + 吊柜的"长度 × 层数"总和（cm），用于 expanded/double 间距反算 */
  totalLayerLength: number;
  /** manual 模式下用户勾选的品类（按 id 引用 categoryCatalog），其他模式留空数组 */
  requestCategories: { id: string }[];
}

/** 选品策略的输出。布局判定、柜台分配、imageGen 由路由层基于此结果继续处理。 */
export interface SelectionResult {
  /** 已排序的待陈列品规列表 */
  specs: Category[];
  /** 参与过陈列的 spec_id 集合，供背柜主题匹配使用 */
  usedSpecIds: Set<string>;
  /** 资源不足时被过滤的紧俏烟（仅 smart 模式可能产生），前端展示提示 */
  filteredHotSpecs?: { id: string; name: string }[];
}

export type StrategyFn = (ctx: SelectionContext) => Promise<SelectionResult>;

/** 业务层校验错误：被路由层捕获并转换为 HTTP 400 响应。 */
export class ValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
