import { Counter, CounterResult, CounterType } from '../types';

const COUNTER_TYPE_LABEL: Record<CounterType, string> = {
  front: '前柜',
  back: '背柜',
  corner: '转角柜',
};

export function mockGenerate(counters: Counter[]): CounterResult[] {
  return counters.map(c => ({
    counterId: c.id,
    counterType: c.type,
    // imageUrl:
    //   'https://via.placeholder.com/600x400?text=' +
    //   encodeURIComponent(COUNTER_TYPE_LABEL[c.type]),
    imageUrl: `mock:${c.type}`,  // 改这里，返回标记而不是外链
  }));
}
