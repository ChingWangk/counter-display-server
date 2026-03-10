"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mockGenerate = mockGenerate;
const COUNTER_TYPE_LABEL = {
    front: '前柜',
    back: '背柜',
    corner: '转角柜',
};
function mockGenerate(counters) {
    return counters.map(c => ({
        counterId: c.id,
        counterType: c.type,
        // imageUrl:
        //   'https://via.placeholder.com/600x400?text=' +
        //   encodeURIComponent(COUNTER_TYPE_LABEL[c.type]),
        imageUrl: `mock:${c.type}`, // 改这里，返回标记而不是外链
    }));
}
