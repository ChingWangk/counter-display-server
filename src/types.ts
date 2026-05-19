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
}

export interface GenerateResponse {
  success: boolean;
  results?: CounterResult[];
  filteredHotSpecs?: { id: string; name: string }[];
  zonePlacements?: import('./services/strategies/types').ZonePlacement[];
  error?: string;
}
