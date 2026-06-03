"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZONE_PRIORITY_ORDER = exports.ZONE_META = exports.ValidationError = exports.FESTIVAL_META = void 0;
/** 8 个传统节日的元信息,供前端 picker 渲染。 */
exports.FESTIVAL_META = {
    newYear: { id: 'newYear', label: '元旦', icon: '🎊' },
    springFestival: { id: 'springFestival', label: '春节', icon: '🧧' },
    lanternFestival: { id: 'lanternFestival', label: '元宵', icon: '🏮' },
    qingming: { id: 'qingming', label: '清明', icon: '🌳' },
    dragonBoat: { id: 'dragonBoat', label: '端午', icon: '🐉' },
    midAutumn: { id: 'midAutumn', label: '中秋', icon: '🌕' },
    nationalDay: { id: 'nationalDay', label: '国庆', icon: '🇨🇳' },
    chongyang: { id: 'chongyang', label: '重阳', icon: '🌼' },
};
/** 业务层校验错误：被路由层捕获并转换为 HTTP 400 响应。 */
class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.status = 400;
        this.name = 'ValidationError';
    }
}
exports.ValidationError = ValidationError;
/** 7 个专区的元信息。供 /api/zones/available 返回 + 策略层落位查表 + imageGen 取色/取展示模式。
 *  tier: basic=基础版(industrialCoop/productUpgrade/substitute), advanced=进阶版(keyRecommend/newProduct/festivalSeason/beadFlavor)。 */
exports.ZONE_META = {
    industrialCoop: {
        id: 'industrialCoop',
        label: '工商共育',
        icon: '🤝',
        description: '工商共育规格，独立行陈列以提升曝光',
        priorityRank: 1,
        tier: 'basic',
        barColor: '#1976D2',
        displayMode: 'single',
        targetCabinetType: 'displayCabinet',
    },
    productUpgrade: {
        id: 'productUpgrade',
        label: '产品升级',
        icon: '📈',
        description: '上海集团新品搭配同产地/同品牌的集团紧俏组合陈列，借紧俏带动新品销量',
        priorityRank: 1,
        tier: 'basic',
        barColor: '#00838F',
        displayMode: 'grouped',
        targetCabinetType: 'displayCabinet',
    },
    substitute: {
        id: 'substitute',
        label: '平替专区',
        icon: '🔄',
        description: '门店脱销规格 + 其强弱适配平替组合陈列，把"好卖的不够卖"转为可售品规',
        priorityRank: 2,
        tier: 'basic',
        barColor: '#C2185B',
        displayMode: 'grouped',
        targetCabinetType: 'displayCabinet',
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
    },
    newProduct: {
        id: 'newProduct',
        label: '尝鲜专区',
        icon: '✨',
        description: '近期上市的新规格（一/二类 24 月内，其他 12 月内）',
        priorityRank: 2,
        tier: 'advanced',
        barColor: '#2D6A4F',
        displayMode: 'single',
        targetCabinetType: 'displayCabinet',
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
    },
};
/** 用于 zonesAvailable / zone-select 展示顺位的 ZoneId 数组。
 *  industrialCoop / productUpgrade 是 rank=1 组（政策导向），其余为 rank=2 组。
 *  festivalSeason 排在最后:它数据源与其他 zone 完全不同（基于图片目录 + 批发量 + 季节）。 */
exports.ZONE_PRIORITY_ORDER = [
    'industrialCoop',
    'productUpgrade',
    'substitute',
    'keyRecommend',
    'newProduct',
    'beadFlavor',
    'festivalSeason',
];
