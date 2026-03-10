export type CounterType = 'front' | 'back' | 'corner';

export interface Counter {
  id: string;
  type: CounterType;
  width: number;
  height: number;
}

export interface Category {
  id: string;
  name: string;
  imageUrl: string;
}

export interface GenerateRequest {
  counters: Counter[];
  categories: Category[];
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
