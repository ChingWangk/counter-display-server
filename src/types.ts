export type CounterType = 'front' | 'back' | 'corner';

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
}

export interface GenerateRequest {
  counters: Counter[];
  categories: Category[];   // 用户勾选的品规（排除项）
}

export interface CounterResult {
  counterId: string;
  counterType: CounterType;
  imageUrl: string;
}

export interface GenerateResponse {
  success: boolean;
  results?: CounterResult[];
  error?: string;
}
