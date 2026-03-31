import { Category } from '../types';

/**
 * 沪产烟（集团产品）品牌优先级
 * 熊猫 > 中华 > 牡丹 > 红双喜 > 大前门 > 中南海
 * 其余集团品牌排在中南海之后
 */
const GROUP_BRAND_ORDER = ['熊猫', '中华', '牡丹', '红双喜', '大前门', '中南海'];

/**
 * 省外烟产地优先级（产地集中原则）
 */
const PROVINCE_ORDER = [
  '云南', '浙江', '湖北', '江苏', '山东', '安徽',
  '湖南', '河南', '贵州', '陕西', '重庆', '福建',
  '四川', '河北', '吉林', '江西', '广东', '甘肃',
  '广西', '海南', '黑龙江', '内蒙古', '辽宁',
];

/**
 * 按陈列规则排序品规列表
 *
 * 规则：
 * 1. 集团产品先行，品牌按 GROUP_BRAND_ORDER 排列，同品牌内价格从高到低
 * 2. 省外烟按产地集中原则（PROVINCE_ORDER），同产地内价格从高到低
 * 3. 外烟最后，价格从高到低
 */
export function sortCategories(available: Category[]): Category[] {
  const group: Category[] = [];
  const provincial: Category[] = [];
  const foreign: Category[] = [];

  for (const c of available) {
    if (c.category === 'group') group.push(c);
    else if (c.category === 'provincial') provincial.push(c);
    else foreign.push(c);
  }

  // 集团产品：按品牌优先级，同品牌按价格降序
  group.sort((a, b) => {
    const ai = GROUP_BRAND_ORDER.indexOf(a.brand);
    const bi = GROUP_BRAND_ORDER.indexOf(b.brand);
    const aOrder = ai === -1 ? GROUP_BRAND_ORDER.length : ai;
    const bOrder = bi === -1 ? GROUP_BRAND_ORDER.length : bi;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return b.price - a.price;
  });

  // 省外烟：按产地优先级，同产地按价格降序
  provincial.sort((a, b) => {
    const ai = PROVINCE_ORDER.indexOf(a.province || '');
    const bi = PROVINCE_ORDER.indexOf(b.province || '');
    const aOrder = ai === -1 ? PROVINCE_ORDER.length : ai;
    const bOrder = bi === -1 ? PROVINCE_ORDER.length : bi;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return b.price - a.price;
  });

  // 外烟：按价格降序
  foreign.sort((a, b) => b.price - a.price);

  return [...group, ...provincial, ...foreign];
}
