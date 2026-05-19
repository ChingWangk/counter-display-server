import { Category } from '../../types';

/** 选品策略的输入上下文，由路由层基于请求体计算后传入。 */
export interface SelectionContext {
  /** 客户编号；manual 模式可为空，smart 模式必填（在策略内部校验） */
  customerId?: string;
  /** 前柜 + 吊柜的总容量（包数） */
  totalSlots: number;
  /** 前柜 + 吊柜的"长度 × 层数"总和（cm），用于 expanded 间距反算 */
  totalLayerLength: number;
  /** manual 模式下用户勾选的品类（按 id 引用 categoryCatalog），其他模式留空数组 */
  requestCategories: { id: string }[];
  /** 用户在 zone-select 页面给出的专区分配。空数组或缺省表示不启用任何专区。 */
  zoneAssignments?: ZoneAssignment[];
}

/** 单个 spec 的库存快照信息，由常规客户策略从 cust_inventory 提取后随结果回传，
 *  供后续滞销 / 脱销 / 平替等专区策略使用。 */
export interface SpecInventoryInfo {
  spec_id: string;
  stock_qty: number;
  stock_days: number;
  snapshot_date: string;  // YYYY-MM-DD
}

/** 专区 id 枚举（与前端 ZoneId 对齐） */
export type ZoneId = 'industrialCoop' | 'substitute' | 'slowMoving' | 'nostalgia' | 'newProduct';

/** 专区静态元信息：名称、图标、说明、优先组、色条颜色、展示模式。 */
export interface ZoneMeta {
  id: ZoneId;
  label: string;
  icon: string;
  description: string;
  /** 1=政策导向（最高优先），2=现实困难。柜台内排序按 (priorityRank ASC, groupCount DESC) */
  priorityRank: 1 | 2;
  /** 行最左侧色条颜色，与前端预览/result 卡片 chip 颜色一致 */
  barColor: string;
  /** 展示模式：
   *   single  - 单品陈列(每包紧贴,按 id 切换处留 gap),用于 industrialCoop / slowMoving / newProduct
   *   grouped - 分组陈列(主规格占双倍宽 + 替代规格紧随,组与组之间留 gap),用于 substitute / nostalgia
   */
  displayMode: 'single' | 'grouped';
}

/** 一组陈列单元：主规格 + N 个替代规格。
 *  - substitute：primary = 脱销规格，alternatives = ref_co_purchase_rules Top 3 在售平替
 *  - nostalgia： primary = 退市规格，alternatives = [successor]（在售）
 *  - 未来 productUpgrade：primary = 老规格，alternatives = 新品/紧俏组合
 */
export interface ZoneGroup {
  primary: ZoneSpec;
  alternatives: ZoneSpec[];
}

/** /api/zones/available 返回的可用专区项。
 *  - 单品专区：groups 缺省/空数组；specs 是该专区的规格列表；groupCount = specs.length
 *  - 分组专区：groups 非空；specs 是 primary 列表(供前端预览展示)；groupCount = groups.length
 */
export interface AvailableZone extends ZoneMeta {
  /** 分组专区 = 组数; 单品专区 = 规格数。前端卡片显示 "X 组"。 */
  groupCount: number;
  specs: ZoneSpec[];
  groups?: ZoneGroup[];
}

/** 用户在 zone-select 页面给出的单条分配。row_count ≥ 1，单柜台累计不超过该柜台空闲层数。 */
export interface ZoneAssignment {
  zone_id: ZoneId;
  counter_id: string;
  row_count: number;
}

/** 策略层根据 zoneAssignments 计算的最终落位：具体哪些 group 落到哪个柜台的几行。 */
export interface ZonePlacement {
  zoneId: ZoneId;
  /** 专区显示名（由 ZONE_META.label 填充，避免前端硬编码映射） */
  label: string;
  counterId: string;
  rowCount: number;
  /** sortCategories 排好序的陈列组。imageGen 据此绘制 zone 行。
   *  - 单品专区：每个 group 的 alternatives 为 []，primary 即原 spec
   *  - 分组专区：primary = 主规格，alternatives = 替代规格(已过滤为客户在售) */
  groups: ZonePlacementGroup[];
  /** 展示模式：从 ZONE_META.displayMode 透传。imageGen 据此决定 primary 单宽还是双宽。 */
  displayMode: 'single' | 'grouped';
  barColor: string;
  priorityRank: number;
  /** 用于柜台内子专区按组数(或单品专区规格数)降序排序 */
  groupCount: number;
}

/** Category 形态的单组陈列单元(供 imageGen 绘制)。 */
export interface ZonePlacementGroup {
  primary: Category;
  alternatives: Category[];
}

/** 专区单条规格的展示数据；不同专区按需填充扩展字段。 */
export interface ZoneSpec {
  id: string;
  name: string;
  imageUrl: string;
  /** 滞销专区：积压天数 */
  stock_days?: number;
  /** 滞销专区：当前库存条数 */
  stock_qty?: number;
  /** 怀旧专区：继任规格 id（可为 null 表示无继任） */
  successor_id?: string | null;
  /** 尝鲜专区：上市日期 YYYY-MM-DD */
  launch_date?: string | null;
}

/** 常规客户专区分类结果。任一专区为空数组表示当前数据下无匹配规格。
 *  注：经 classifyZones 优先级 dedupe 后,同一 spec 只会出现在一个专区里。
 *  分组专区(substitute / nostalgia)的 dedupe 颗粒度按 primary id —— 同一 primary
 *  最多归属一个分组专区;alternatives 不参与 dedupe(允许跨专区作为 primary 出现)。 */
export interface ZoneClassification {
  industrialCoop: ZoneSpec[];  // 工商共育：is_industrial_coop = true
  substitute: ZoneGroup[];     // 平替专区：{primary: 脱销规格, alternatives: Top 3 在售平替}
  slowMoving: ZoneSpec[];      // 滞销夸夸角：stock_days ≥ 30 且 stock_qty ≥ 3
  nostalgia: ZoneGroup[];      // 怀旧专区：{primary: 退市规格, alternatives: [在售 successor]}
  newProduct: ZoneSpec[];      // 尝鲜专区：launch_date 在窗口期内（一二类 24 月，其他 12 月）
}

/** 选品策略的输出。布局判定、柜台分配、imageGen 由路由层基于此结果继续处理。 */
export interface SelectionResult {
  /** 已排序的待陈列品规列表（已扣除被划入 zonePlacements 的 spec） */
  specs: Category[];
  /** 参与过陈列的 spec_id 集合（含 zone specs + regular specs），供背柜主题匹配使用 */
  usedSpecIds: Set<string>;
  /** 资源不足时被过滤的紧俏烟（仅 smart 模式可能产生），前端展示提示 */
  filteredHotSpecs?: { id: string; name: string }[];
  /** spec_id → 最新库存快照。仅常规客户策略会填充，其它策略缺省。 */
  inventoryById?: Map<string, SpecInventoryInfo>;
  /** 根据 ctx.zoneAssignments 落位后的专区结果。生成图像时顶部行用此数据。 */
  zonePlacements?: ZonePlacement[];
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

/** 5 个专区的元信息。供 /api/zones/available 返回 + 策略层落位查表 + imageGen 取色/取展示模式。 */
export const ZONE_META: Record<ZoneId, ZoneMeta> = {
  industrialCoop: {
    id: 'industrialCoop',
    label: '工商共育',
    icon: '🤝',
    description: '工商共育规格，独立行陈列以提升曝光',
    priorityRank: 1,
    barColor: '#1976D2',
    displayMode: 'single',
  },
  substitute: {
    id: 'substitute',
    label: '平替专区',
    icon: '🔄',
    description: '门店脱销规格 + 其强弱适配平替组合陈列，把"好卖的不够卖"转为可售品规',
    priorityRank: 2,
    barColor: '#C2185B',
    displayMode: 'grouped',
  },
  slowMoving: {
    id: 'slowMoving',
    label: '滞销夸夸角',
    icon: '🛒',
    description: '积压 ≥ 30 天且库存 ≥ 3 条的规格，集中展示便于推广',
    priorityRank: 2,
    barColor: '#F9A825',
    displayMode: 'single',
  },
  nostalgia: {
    id: 'nostalgia',
    label: '怀旧专区',
    icon: '📷',
    description: '已退市但门店仍有库存的经典规格 + 其在售继任规格，按品牌替代成组陈列',
    priorityRank: 2,
    barColor: '#8D6E63',
    displayMode: 'grouped',
  },
  newProduct: {
    id: 'newProduct',
    label: '尝鲜专区',
    icon: '✨',
    description: '近期上市的新规格（一/二类 24 月内，其他 12 月内）',
    priorityRank: 2,
    barColor: '#2D6A4F',
    displayMode: 'single',
  },
};

/** 用于 dedupe 和 classifyZones 内部顺序的 ZoneId 优先级数组。
 *  industrialCoop 是 1 组（政策导向），其余四个为 2 组（现实困难/趋势顺应）。
 *  substitute 排在 slowMoving 之前：平替推荐的是"卖得好但缺货"的强适配品，比滞销更值得优先曝光。 */
export const ZONE_PRIORITY_ORDER: ZoneId[] = [
  'industrialCoop',
  'substitute',
  'slowMoving',
  'nostalgia',
  'newProduct',
];
