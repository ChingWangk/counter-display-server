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

/** 专区 id 枚举（与前端 ZoneId 对齐）。
 *  keyRecommend = 重点推荐区(由原 slowMoving 滞销夸夸角 + nostalgia 怀旧专区合并而来)。
 *  原 localShanghai / shortSlimBead 已下线。 */
export type ZoneId = 'industrialCoop' | 'productUpgrade' | 'substitute' | 'keyRecommend' | 'newProduct' | 'festivalSeason' | 'beadFlavor';

/** 专区版本档位:basic=基础版(政策/经营刚需), advanced=进阶版(趋势/特色)。
 *  edition-select 页面据此把专区分两组,用户结合柜台资源勾选要启用的版本。 */
export type ZoneTier = 'basic' | 'advanced';

/** 节日 id 枚举(仅 festivalSeason 专区使用,用户在 zone-select 卡片上手动选择)。 */
export type FestivalId =
  | 'newYear'         // 元旦
  | 'springFestival'  // 春节
  | 'lanternFestival' // 元宵
  | 'qingming'        // 清明
  | 'dragonBoat'      // 端午
  | 'midAutumn'       // 中秋
  | 'nationalDay'     // 国庆
  | 'chongyang';      // 重阳

export interface FestivalMeta {
  id: FestivalId;
  label: string;
  icon: string;
}

/** 8 个传统节日的元信息,供前端 picker 渲染。 */
export const FESTIVAL_META: Record<FestivalId, FestivalMeta> = {
  newYear:         { id: 'newYear',         label: '元旦', icon: '🎊' },
  springFestival:  { id: 'springFestival',  label: '春节', icon: '🧧' },
  lanternFestival: { id: 'lanternFestival', label: '元宵', icon: '🏮' },
  qingming:        { id: 'qingming',        label: '清明', icon: '🌳' },
  dragonBoat:      { id: 'dragonBoat',      label: '端午', icon: '🐉' },
  midAutumn:       { id: 'midAutumn',       label: '中秋', icon: '🌕' },
  nationalDay:     { id: 'nationalDay',     label: '国庆', icon: '🇨🇳' },
  chongyang:       { id: 'chongyang',       label: '重阳', icon: '🌼' },
};

/** 专区静态元信息：名称、图标、说明、优先组、色条颜色、展示模式。 */
export interface ZoneMeta {
  id: ZoneId;
  label: string;
  icon: string;
  description: string;
  /** 1=政策导向（最高优先），2=现实困难/趋势顺应。柜台内排序按 (priorityRank ASC, groupCount DESC) */
  priorityRank: 1 | 2;
  /** 版本档位:basic=基础版, advanced=进阶版。edition-select 页面据此分组。 */
  tier: ZoneTier;
  /** 行最左侧色条颜色，与前端预览/result 卡片 chip 颜色一致。backFestival 不走 imageGen,此字段仅用于前端 chip。 */
  barColor: string;
  /** 展示模式：
   *   single        - 单品陈列(每包紧贴,按 id 切换处留 gap),用于 industrialCoop / newProduct / beadFlavor
   *   grouped       - 分组陈列(primary + 每个 alternative 均单包,组与组之间留 gap),用于 substitute / productUpgrade / keyRecommend
   *                   keyRecommend 的组可为"无 alternative 的单品"(原滞销品),与"带继任的组"(原怀旧品)混排
   *   backFestival  - 背柜节日单图直出(整张背柜 = 1 张预拍图,不走 imageGen 绘制流程),用于 festivalSeason
   */
  displayMode: 'single' | 'grouped' | 'backFestival';
  /** 适用的柜台类型。
   *   displayCabinet - 前柜 / 吊柜(默认),走 imageGen 顶部 zone 行
   *   backCabinet    - 背柜(仅 festivalSeason),走 generate.ts 背柜分支单图直出
   */
  targetCabinetType: 'displayCabinet' | 'backCabinet';
  /** 布局类别(与前端 types/index.d.ts ZoneMeta.layoutKind 对齐):
   *   zoneRows     - 占行专区,用户在 zone-select 选目标柜台 + 占用行数(默认,绝大多数专区)
   *   fixedTop     - 固定首柜前两行(仅开关):工商共育「条+3包+条+3包」固定陈列,
   *                  不让用户选柜台/行数,generate.ts 强制落到 displayCounters[0] 顶部两行
   *   inlineRegular- 内嵌常规行红框配对(产品升级/平替,仅开关):不占行,由 generate.ts computeInlinePairs
   *                  从常规陈列找出主规格,右侧紧跟一个副规格,imageGen 用粗红框圈住这对
   *   backFestival - 背柜节日单图直出(仅 festivalSeason)
   */
  layoutKind: 'zoneRows' | 'fixedTop' | 'inlineRegular' | 'backFestival';
}

/** 一组陈列单元：主规格 + N 个替代规格。
 *  - substitute：primary = 脱销规格，alternatives = 业务排序后 Top 2 在售平替
 *  - productUpgrade：primary = 上海集团新品(launch_date 在窗口期), alternatives = 同产地/同品牌的集团紧俏组合 Top 2
 *  - keyRecommend：两种组混排 —— 怀旧组{primary=退市规格, alternatives=[在售继任]} + 滞销组{primary=滞销规格, alternatives=[]}
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

/** 用户在 zone-select 页面给出的单条分配。row_count ≥ 1，单柜台累计不超过该柜台空闲层数。
 *  festivalSeason 的 row_count 实际不被消费(背柜单图直出),前端可恒传 1;但 festival_id 必填。 */
export interface ZoneAssignment {
  zone_id: ZoneId;
  counter_id: string;
  row_count: number;
  /** 仅 zone_id === 'festivalSeason' 时填充,选哪个节日。 */
  festival_id?: FestivalId;
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
  /** 展示模式：从 ZONE_META.displayMode 透传。imageGen 据此决定 primary 单宽还是双宽。
   *  backFestival 走 generate.ts 背柜分支单图直出,不进入 imageGen;仅用于响应 + 前端 result chip 渲染。 */
  displayMode: 'single' | 'grouped' | 'backFestival';
  /** 从 ZONE_META.layoutKind 透传。fixedTop(工商共育)时 imageGen 把本专区的条行渲染在柜台最顶、
   *  常规行整体下移;其余取值走常规底部 zone 行逻辑。缺省视为 zoneRows。 */
  layoutKind?: 'zoneRows' | 'fixedTop' | 'inlineRegular' | 'backFestival';
  barColor: string;
  priorityRank: number;
  /** 用于柜台内子专区按组数(或单品专区规格数)降序排序 */
  groupCount: number;
  /** festivalSeason 专用:用户选的节日 id。供前端 result 卡片"查看话术"按 festival_id 拉对应节日话术。 */
  festivalId?: FestivalId;
  /** newProduct(尝鲜)专用:本柜需"店长推荐"高亮的重点品规 id(按优先级序,客户在售子集)。
   *  imageGen 据此把这些规格排成 2×2 居中方块、加宽并垫店长推荐装饰;其余新品环绕。 */
  highlightIds?: string[];
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
 *  各专区独立计算,同一品规可在不同专区重复出现。
 *  分组专区(substitute / nostalgia / productUpgrade)的 alternatives 不参与去重(允许跨专区出现)。 */
export interface ZoneClassification {
  industrialCoop: ZoneSpec[];  // 工商共育：is_industrial_coop = true
  productUpgrade: ZoneGroup[]; // 产品升级：上海集团新品(launch_date 在窗口期) + 同产地/同品牌的集团紧俏组合 Top 2
  substitute: ZoneGroup[];     // 平替专区：{primary: 脱销规格, alternatives: 业务排序后 Top 2 在售平替}
  /** 重点推荐区(原滞销夸夸角 + 怀旧专区合并):
   *  怀旧组{primary: 退市规格, alternatives: [在售继任]} 与 滞销组{primary: 滞销规格, alternatives: []} 混排。
   *  同一 primary 不重复(怀旧组优先,滞销与之 id 重复时跳过)。 */
  keyRecommend: ZoneGroup[];
  newProduct: ZoneSpec[];      // 尝鲜专区：launch_date 在窗口期内（一二类 24 月，其他 12 月）
  /** 爆珠口味组合:pack_type 含'爆珠',按 flavor 分组聚集(薄荷>水果>功能性>原味>其他),组内按价格降序 */
  beadFlavor: ZoneSpec[];
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

/** 7 个专区的元信息。供 /api/zones/available 返回 + 策略层落位查表 + imageGen 取色/取展示模式。
 *  tier: basic=基础版(industrialCoop/productUpgrade/substitute), advanced=进阶版(keyRecommend/newProduct/festivalSeason/beadFlavor)。 */
export const ZONE_META: Record<ZoneId, ZoneMeta> = {
  industrialCoop: {
    id: 'industrialCoop',
    label: '工商共育',
    icon: '🤝',
    description: '勾选即固定占据第一个柜台前两行,以「条+3包+条+3包」高曝光陈列(品规按优先级自动排布)',
    priorityRank: 1,
    tier: 'basic',
    barColor: '#1976D2',
    displayMode: 'single',
    targetCabinetType: 'displayCabinet',
    layoutKind: 'fixedTop',
  },
  productUpgrade: {
    id: 'productUpgrade',
    label: '产品升级',
    icon: '📈',
    description: '勾选即在常规陈列中把待升级老品与同品牌升级新品并排,用红框圈出高亮,借常规曝光带动新品(自动嵌入常规行,不单独占行)',
    priorityRank: 1,
    tier: 'basic',
    barColor: '#00838F',
    displayMode: 'grouped',
    targetCabinetType: 'displayCabinet',
    layoutKind: 'inlineRegular',
  },
  substitute: {
    id: 'substitute',
    label: '平替专区',
    icon: '🔄',
    description: '勾选即在常规陈列中把脱销规格与其平替并排,用红框圈出高亮,提示客人可买的替代款(自动嵌入常规行,不单独占行)',
    priorityRank: 2,
    tier: 'basic',
    barColor: '#C2185B',
    displayMode: 'grouped',
    targetCabinetType: 'displayCabinet',
    layoutKind: 'inlineRegular',
  },
  keyRecommend: {
    id: 'keyRecommend',
    label: '重点推荐区',
    icon: '⭐',
    description: '滞销规格集中夸夸促销 + 退市经典搭配在售继任,把压货和老客需求一起盘活',
    priorityRank: 2,
    tier: 'advanced',
    barColor: '#8D6E63',
    displayMode: 'grouped',
    targetCabinetType: 'displayCabinet',
    layoutKind: 'zoneRows',
  },
  newProduct: {
    id: 'newProduct',
    label: '尝鲜专区',
    icon: '✨',
    description: '近期上市的新规格(一/二类 24 月内,其他 12 月内),每个新品正反面陈列;中心 2×2 居中摆放在售的中华重点品规并以"店长推荐"背景高亮,其余按价位段降序环绕',
    priorityRank: 2,
    tier: 'advanced',
    barColor: '#2D6A4F',
    displayMode: 'single',
    targetCabinetType: 'displayCabinet',
    layoutKind: 'zoneRows',
  },
  festivalSeason: {
    id: 'festivalSeason',
    label: '节日季节',
    icon: '🎁',
    description: '节日 + 当季季节匹配，按高价烟批发量 + 季节优先(夏秋爆珠薄荷 / 冬春短支)选图，整张背柜单图直出',
    priorityRank: 2,
    tier: 'advanced',
    barColor: '#9C27B0',
    displayMode: 'backFestival',
    targetCabinetType: 'backCabinet',
    layoutKind: 'backFestival',
  },
  beadFlavor: {
    id: 'beadFlavor',
    label: '爆珠口味组合',
    icon: '🫐',
    description: '爆珠规格按口味聚集(薄荷/水果/功能性),便于顾客横向比较口味',
    priorityRank: 2,
    tier: 'advanced',
    barColor: '#EF6C00',
    displayMode: 'single',
    targetCabinetType: 'displayCabinet',
    layoutKind: 'zoneRows',
  },
};

/** 用于 zonesAvailable / zone-select 展示顺位的 ZoneId 数组。
 *  industrialCoop / productUpgrade 是 rank=1 组（政策导向），其余为 rank=2 组。
 *  festivalSeason 排在最后:它数据源与其他 zone 完全不同（基于图片目录 + 批发量 + 季节）。 */
export const ZONE_PRIORITY_ORDER: ZoneId[] = [
  'industrialCoop',
  'productUpgrade',
  'substitute',
  'keyRecommend',
  'newProduct',
  'beadFlavor',
  'festivalSeason',
];
