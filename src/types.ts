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
}

export interface GenerateRequest {
  counters: Counter[];
  categories: Category[];   // 用户勾选的品规，同一品规可重复出现（多选计数）
  mode?: 'smart' | 'manual';  // smart=智能推荐（后端自动选品），manual=自选规格
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
  error?: string;
}

// 陈列布局策略
export interface LayoutConfig {
  mode: 'double' | 'expanded' | 'standard';
  gapCm: number;  // 规格间隙（cm），standard 模式下忽略
}
