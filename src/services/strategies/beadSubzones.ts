import { Category } from '../../types';

/**
 * 爆珠口味子专区配置(本文件 = 维护爆珠分类的唯一入口)。
 *
 * 业务:爆珠专区(beadFlavor)按口味拆成多个「子专区」,出图时在左侧标签栏分段竖标。
 * 规格归属由 dim_category_ext.flavor → 子专区:命中首个 flavors 含该口味的子专区,
 * 都不命中则落入末尾的「其他」段(BEAD_OTHER_SUBZONE)。
 *
 * ★维护方式(无需改其它代码):
 *   - 调整某子专区收哪些口味 → 改对应 flavors 数组;
 *   - 增 / 删 / 改顺序 → 直接增删 BEAD_SUBZONES 元素(数组顺序 = 出图从上到下/从左到右的段顺序);
 *   - 换标签贴图 → 改 iconImage(资产上传到 /www/wwwroot/47.103.65.4 + 该路径;缺图自动画底色色块占位);
 *   - 换左栏分段底色 → 改 barColor。
 *
 * 注意:flavors 里的字符串必须与 dim_category_ext.flavor 的真实取值**完全一致**才会命中。
 *   现库 flavor 已归一化为四种 + 空:果香 / 酒香 / 草本 / 其它(非爆珠烟为空),
 *   分别对齐下面 fruitFloral / liquorDrink / herbal / (other 兜底)。归一化规则与脚本见
 *   scripts/normalize_flavor.py;数组里其余字符串为冗余别名,保留以兼容未来更细的口味取值。
 *   核对命令:SELECT spec_id, spec_name, flavor FROM dim_category_ext WHERE pack_type LIKE '%爆珠%';
 */
export interface BeadSubzoneDef {
  /** 稳定 id(渲染分段 / 日志用,勿随意改) */
  id: string;
  /** 子专区名(竖排画在左侧标签栏) */
  label: string;
  /** 左栏顶部小图标贴图路径(相对 /www/wwwroot/47.103.65.4;缺图画 barColor 圆角色块占位) */
  iconImage: string;
  /** 左栏该段底色(三段用不同色以便肉眼分段) */
  barColor: string;
  /** ★主要维护处:归入本子专区的 dim_category_ext.flavor 取值集合 */
  flavors: string[];
}

/** 子专区定义。**数组顺序即陈列顺序**。 */
export const BEAD_SUBZONES: BeadSubzoneDef[] = [
  {
    id: 'fruitFloral',
    label: '果香花香',
    iconImage: '/images/decor/bead-fruit.png',
    barColor: '#C0D663',
    flavors: ['水果香', '果香', '花香', '香甜', '蓝莓', '青柠', '西瓜', '柑橘', '葡萄', '水蜜桃', '玫瑰', '茉莉'],
  },
  {
    id: 'liquorDrink',
    label: '酒香饮品',
    iconImage: '/images/decor/bead-liquor.png',
    barColor: '#BF4382',
    flavors: ['酒香', '洋酒', '威士忌', '朗姆', '咖啡', '可乐', '奶茶', '饮品', '气泡'],
  },
  {
    id: 'herbal',
    label: '特色草本',
    iconImage: '/images/decor/bead-herbal.png',
    barColor: '#24D6A0',
    flavors: ['薄荷', '草本', '茶香', '清凉', '原味', '功能性', '人参', '凉茶'],
  },
];

/** 未匹配任何子专区的口味 → 落入此「其他」段,恒排末尾。 */
export const BEAD_OTHER_SUBZONE: Omit<BeadSubzoneDef, 'flavors'> = {
  id: 'other',
  label: '其他',
  iconImage: '/images/decor/bead-other.png',
  barColor: '#9E9E9E',
};

/** 子专区 id → 元信息(含 other),供渲染/落位查 label/iconImage/barColor。 */
export function beadSubzoneMeta(id: string): Omit<BeadSubzoneDef, 'flavors'> {
  if (id === BEAD_OTHER_SUBZONE.id) return BEAD_OTHER_SUBZONE;
  const def = BEAD_SUBZONES.find(s => s.id === id);
  return def ?? BEAD_OTHER_SUBZONE;
}

/** flavor → 子专区 id:命中首个 flavors 含该口味的子专区,否则 'other'。 */
export function flavorToSubzoneId(flavor: string | null | undefined): string {
  const f = (flavor ?? '').trim();
  if (f) {
    for (const sz of BEAD_SUBZONES) {
      if (sz.flavors.includes(f)) return sz.id;
    }
  }
  return BEAD_OTHER_SUBZONE.id;
}

/** 子专区**外层排序键**:BEAD_SUBZONES 内的下标;other 永远最后。 */
export function beadSubzoneRank(id: string): number {
  const idx = BEAD_SUBZONES.findIndex(s => s.id === id);
  return idx === -1 ? BEAD_SUBZONES.length : idx;  // other / 未知 → 末尾
}

/**
 * 子专区**内排序**:铺市面(market_coverage)低→高 → 订足率(order_fill_rate)高→低 → 兜底价格高→低。
 * 缺指标的规格排在有指标的规格之后,彼此按价格降序;整段都缺指标时自然退化为纯价格降序
 * (对齐需求:"缺相关数据就先按价格排")。
 */
export function compareBeadWithinSubzone(a: Category, b: Category): number {
  const ca = a.market_coverage;
  const cb = b.market_coverage;
  const aHas = ca != null;
  const bHas = cb != null;
  if (aHas && bHas) {
    if (ca !== cb) return ca - cb;                 // 铺市面 升序(低的排前)
    const fa = a.order_fill_rate ?? -Infinity;
    const fb = b.order_fill_rate ?? -Infinity;
    if (fa !== fb) return fb - fa;                 // 订足率 降序(高的排前)
    return (b.price ?? 0) - (a.price ?? 0);        // 兜底:价格降序
  }
  if (aHas) return -1;                             // 有指标者在前
  if (bHas) return 1;
  return (b.price ?? 0) - (a.price ?? 0);          // 都缺:价格降序
}
