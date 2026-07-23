export type CounterType = 'front' | 'back' | 'hanging';

export interface Counter {
  id: string;
  type: CounterType;
  length: number;   // 柜台长度，单位 cm
  levels: number;   // 层数
}

export interface Category {
  id: string;
  name: string;
  imageUrl: string;
  price: number;            // 批发价（元/条）
  brand: string;            // 品牌名，如 "中南海"
  manufacturer: string;     // 制造商
  category: 'group' | 'provincial' | 'foreign';  // 集团产品 / 省外烟 / 外烟
  province: string | null;  // 省外烟的省份，其他为 null
  is_hot: boolean;          // 是否为紧俏烟
  // 以下字段来自 dim_category_ext（运行时通过 getExtendedCategoryMap 合并），
  // 在表未就绪 / 该规格未补录时为 undefined。专区策略需要做空值判断。
  pack_type?: string;             // 支型：常规 / 中支 / 细支 / 短支 / 爆珠
  flavor?: string | null;         // 口味：烤烟 / 混合 / 薄荷 / 香甜
  tier?: string | null;           // 价类：一类 / 二类 / 三类 / 四类 / 五类
  launch_date?: string | null;    // 上市日期 YYYY-MM-DD（用于尝鲜专区）
  is_industrial_coop?: boolean;   // 是否工商共育
  is_delisted?: boolean;          // 是否已退市（用于怀旧专区）
  successor_id?: string | null;   // 退市后的继任规格 id
  retail_price?: number;          // 零售指导价（元/包）← dim_category_ext.price；缺录/列未就绪为 undefined（区别于批发价 price）
  // 以下两项来自独立 ref 表(getExtendedCategoryMap 叠加,各取最新 snapshot_month),非 dim_category_ext:
  market_coverage?: number | null; // 铺市面 ← ref_market_coverage.coverage_rate（爆珠子专区内升序——低的排前）
  order_fill_rate?: number | null; // 订足率 ← ref_order_fill_rate.fill_rate（爆珠子专区内降序——高的排前）
}

export interface GenerateRequest {
  counters: Counter[];
  categories: Category[];   // 用户勾选的品规，同一品规可重复出现（多选计数）
  mode?: 'smart' | 'manual';  // smart=智能推荐（后端自动选品），manual=自选规格
  customer_id?: string;
  zone_assignments?: import('./services/strategies/types').ZoneAssignment[];
}

export interface CounterResult {
  counterId: string;
  counterType: CounterType;
  imageUrl: string;
  layerImages?: string[];
  /** 「导出柜台规格」xlsx 的下载地址(每行 = 图上一层)。写盘失败时缺省,前端据此隐藏导出按钮。 */
  manifestUrl?: string;
}

export interface GenerateResponse {
  success: boolean;
  results?: CounterResult[];
  filteredHotSpecs?: { id: string; name: string }[];
  zonePlacements?: import('./services/strategies/types').ZonePlacement[];
  /** 归档版布局判定(仅无展示柜专区路径,即新客户永远命中)。供前端"陈列说明"机器人叙述真实决策。 */
  layout?: GenerateLayout;
  /** 该客户存在"售价低于区域常卖价"的待升价规格 → 出图已贴价签、前端应显示价签助手悬浮入口。缺省视为 false。 */
  showPriceTag?: boolean;
  /** 客户消费结构档位(cust_consumer_structure.structure_level:high/mid_high/low;查不到则缺省)。
   *  与店长推荐选品同源(generate 内同一次查询透传),尝鲜助手"陈列说明"据此讲清门店面向客群。 */
  structureLevel?: string | null;
  error?: string;
}

/** 归档版三档布局判定结果(generate 的 noDisplayZones 分支产出)。 */
export interface GenerateLayout {
  /** double=双包(资源充足) / expanded=单包扩大间距(适中) / standard=标准紧凑(偏紧) */
  mode: 'double' | 'expanded' | 'standard';
  /** 本次陈列的规格种数(= specs.length,与布局判定同口径) */
  specCount: number;
  /** 前柜+吊柜总容量(包) */
  capacity: number;
  /** 本次陈列的规格 id(去重),供"未经销规格"排除 */
  specIds: string[];
  /** 因陈列资源不足被暂缓上样的紧俏烟数量(=filteredHotSpecs.length)。>0 表示原始规格数已超容量、
   *  specCount 是过滤后的口径 —— 供前端"陈列说明"如实说明"原有超容量→暂缓紧俏→其余铺开",避免与结果页紧俏剔除提示矛盾。 */
  filteredHotCount?: number;
}
