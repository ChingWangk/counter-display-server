import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { GenerateResponse, CounterResult, Category, GenerateLayout } from '../types';
import { generateCounterImage, PACK_WIDTH_CM, RegularFillLayout } from '../services/imageGen';
import {
  SelectionContext,
  SelectionResult,
  ValidationError,
  ZoneAssignment,
  ZonePlacement,
  ZONE_META,
  FestivalId,
} from '../services/strategies/types';
import { autoExpandZonePlacements, resolveManagerPickIds } from '../services/strategies/zones';
import { getCustomerStructureLevel } from '../services/customerStructure';
import { selectFestivalImage } from '../services/strategies/festivalSeason';
import { getExtendedCategoryMap } from '../services/categoryCatalog';
import { buildIndustrialCoopPlacement } from '../services/strategies/industrialCoop';
import { computeInlinePairs, InlineBoxedPair } from '../services/strategies/inlinePairs';
import { manualStrategy } from '../services/strategies/manualStrategy';
import { newCustomerStrategy } from '../services/strategies/newCustomerStrategy';
import { regularCustomerStrategy } from '../services/strategies/regularCustomerStrategy';
import { getCustomerClass } from '../services/customerClass';
import { getCustomerHasPos, fetchRecentStockoutFreq } from '../services/strategies/substitute';
import { getCustomerPriceComparison } from '../services/priceTag';

// 加载背柜主题组数据
interface ThemeGroup { id: string; label: string; specIds: string[]; images: string[]; }
const themesFile = path.join(__dirname, '../data/back-cabinet-themes.json');
const allThemes: ThemeGroup[] = JSON.parse(fs.readFileSync(themesFile, 'utf-8'));
const IMAGE_PREFIX = '/images/back-themes/';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    console.log('[DEBUG] 收到 req.body:', JSON.stringify(req.body));
    const {
      counters,
      categories,
      mode = 'manual',
      customer_id,
      zone_assignments,
    } = req.body as {
      counters: any[];
      categories: any[];
      mode?: 'smart' | 'manual';
      customer_id?: string;
      zone_assignments?: ZoneAssignment[];
    };

    if (!Array.isArray(counters) || counters.length === 0) {
      const body: GenerateResponse = { success: false, error: '柜台列表不能为空' };
      res.status(400).json(body);
      return;
    }

    // 按类型分离柜台：前柜/吊柜参与烟包陈列，背柜单独处理
    const displayCounters = counters.filter((c: any) => c.type === 'front' || c.type === 'hanging');
    const backCounters = counters.filter((c: any) => c.type === 'back');

    // ---- 拆分 zone_assignments:displayCabinet(前柜/吊柜) vs backCabinet(背柜) ----
    // backCabinet 类目(目前仅 festivalSeason)与其他 zone 的数据流完全隔离 —— 不进 selection,
    // 不进 imageGen,由本路由的背柜分支单独处理。
    const allAssignments: ZoneAssignment[] = Array.isArray(zone_assignments) ? zone_assignments : [];
    const displayCabinetAssignments: ZoneAssignment[] = [];
    const backCabinetAssignments: ZoneAssignment[] = [];
    // 价签体检(priceTag)是纯功能开关:不占柜台、不落陈列图,这里剥离出来只记"是否勾选",
    // 绝不放进 display/back assignments,以免进入落位/imageGen 绘制流程。见 ZONE_META.priceTag 注释。
    let priceTagEnabled = false;
    for (const a of allAssignments) {
      const meta = ZONE_META[a.zone_id];
      if (!meta) continue;  // 未知 zone_id 静默忽略(前后端版本不一致时容忍)
      if (a.zone_id === 'priceTag') {
        priceTagEnabled = true;
        continue;
      }
      if (meta.targetCabinetType === 'backCabinet') {
        backCabinetAssignments.push(a);
      } else {
        displayCabinetAssignments.push(a);
      }
    }

    // 校验 backCabinetAssignments
    for (const a of backCabinetAssignments) {
      const target = backCounters.find((c: any) => c.id === a.counter_id);
      if (!target) {
        const body: GenerateResponse = {
          success: false,
          error: `专区分配的柜台 ${a.counter_id} 不存在或非背柜`,
        };
        res.status(400).json(body);
        return;
      }
      if (a.zone_id === 'festivalSeason' && !a.festival_id) {
        const body: GenerateResponse = {
          success: false,
          error: `节日季节专区(背柜 ${a.counter_id})缺少 festival_id`,
        };
        res.status(400).json(body);
        return;
      }
    }

    // 陈列资源（前柜+吊柜），smart/manual 共用
    const totalSlots = displayCounters.reduce((sum: number, c: any) => {
      return sum + Math.floor(c.length / PACK_WIDTH_CM) * c.levels;
    }, 0);
    const totalLayerLength = displayCounters.reduce((sum: number, c: any) => {
      return sum + c.length * c.levels;
    }, 0);

    // ---- 调度选品策略：manual / newCustomer / regularCustomer 三选一 ----
    const ctx: SelectionContext = {
      customerId: customer_id,
      totalSlots,
      totalLayerLength,
      requestCategories: Array.isArray(categories) ? categories : [],
      zoneAssignments: displayCabinetAssignments,
    };

    // 客户类型先算出来:决定后续 priceTag / 背柜去重策略走"归档版"还是"常规客户增强版"
    // 新客户(< 3 月)不应受常规客户专区开发的副作用影响,沿用归档版陈列规则:
    //  - 不计算/不渲染杨浦区均价价签
    //  - 背柜主题图按每柜从 0 开始循环(不跨柜累加 cursor 去重)
    const customerClass = await getCustomerClass(customer_id || '');
    const isNewCustomer = customerClass === 'new';

    let selection: SelectionResult;
    try {
      if (mode === 'manual') {
        selection = await manualStrategy(ctx);
      } else {
        // mode === 'smart':按客户类型分发
        selection = customerClass === 'regular'
          ? await regularCustomerStrategy(ctx)
          : await newCustomerStrategy(ctx);
      }
    } catch (err) {
      if (err instanceof ValidationError) {
        const body: GenerateResponse = { success: false, error: err.message };
        res.status(400).json(body);
        return;
      }
      throw err;
    }

    const specs: Category[] = selection.specs;
    const usedSpecIds: Set<string> = selection.usedSpecIds;
    const filteredHotSpecs: { id: string; name: string }[] = selection.filteredHotSpecs || [];
    // 仅占行专区(zoneRows)进入常规底部 zone 流。纯开关专区(fixedTop 工商共育 / inlineRegular
    // 产品升级·平替)已在 buildZonePlacements 跳过(counter_id 为空,会落空校验),这里按
    // layoutKind 再防御性过滤;它们各由 buildIndustrialCoopPlacement / computeInlinePairs 接管。
    const initialZonePlacements: ZonePlacement[] = (selection.zonePlacements || [])
      .filter(p => (p.layoutKind ?? 'zoneRows') === 'zoneRows');

    // ---- 尝鲜专区「店长推荐」重点品规:计算本次需高亮的在售子集(本档位的店长推荐 ∩ 在售) ----
    // 规格按客户消费结构档位切换,并在 resolveManagerPickIds 内完成"在售过滤 → 缺货补位 → 6/4 收口";
    // 与 classifyZones 注入的那套**必须同源**(两边调同一个函数),否则会高亮一个压根没进专区的 id。
    // 查不到档位两边都回退现网默认,仍然一致。
    // smart 取 stock_qty>0;manual 无库存,已选即视为在售(与 zonesAvailable / classifyZones 同口径)。
    // 落位 highlightIds 盖章见下方 zonePlacements 组装后;imageGen 据此渲染 2×2 居中高亮 + 加宽。
    const npInv = selection.inventoryById;
    const npOnSaleIds = new Set(
      specs.filter(s => (mode === 'smart' ? (npInv?.get(s.id)?.stock_qty ?? 0) > 0 : true)).map(s => s.id),
    );
    const npStructureLevel = await getCustomerStructureLevel(customer_id || '');
    const managerPickIds = resolveManagerPickIds(npStructureLevel, npOnSaleIds);

    // ---- 工商共育 fixedTop 叠加层:强制落到第一个展示柜台(displayCounters[0])的前两行 ----
    // 忽略 toggle 送来的空 counter_id,用 buildIndustrialCoopPlacement 按优先级 + 方案 A
    // 构造「条+3包+条+3包」两行落位;counterId 在此赋为首个展示柜台 id。
    const fixedTopPlacements: ZonePlacement[] = [];
    const fixedTopRowsByCounter = new Map<string, number>();
    const wantIndustrialCoop = displayCabinetAssignments.some(a => a.zone_id === 'industrialCoop');
    if (wantIndustrialCoop && displayCounters.length > 0) {
      const coopExtendedMap = await getExtendedCategoryMap();
      const eligible = specs
        .map(s => coopExtendedMap.get(s.id))
        .filter((c): c is Category => !!c && c.is_industrial_coop === true);
      const target = displayCounters[0];
      const coop = buildIndustrialCoopPlacement(eligible, target.levels);
      if (coop) {
        coop.counterId = target.id;
        fixedTopPlacements.push(coop);
        fixedTopRowsByCounter.set(target.id, coop.rowCount);
      }
    }
    // 某柜台被 fixedTop 占用后,其常规 / 底部专区可用层数 = levels - fixedTop 行数
    const effLevels = (c: { id: string; levels: number }): number =>
      c.levels - (fixedTopRowsByCounter.get(c.id) || 0);

    // ---- 产品升级 / 平替:内嵌常规行红框配对(inlineRegular,不占行) ----
    // 从常规池 specs 找出主规格(升级=待升级老品、平替=脱销规格),右侧紧跟一个副规格,
    // imageGen 用粗红框圈住这对。配对计算见 computeInlinePairs(写死 6 组 + 自动派生)。
    const wantUpgrade = displayCabinetAssignments.some(a => a.zone_id === 'productUpgrade');
    const wantSubstitute = displayCabinetAssignments.some(a => a.zone_id === 'substitute');
    let inlinePairs = new Map<string, InlineBoxedPair>();
    if (wantUpgrade || wantSubstitute) {
      const inv = selection.inventoryById;
      const onSaleIds = new Set(
        specs.filter(s => (inv?.get(s.id)?.stock_qty ?? 0) > 0).map(s => s.id),
      );
      // 平替脱销判定:POS 客户用近一周脱销集+季度频次(cust_recent_stockout);非 POS 无日结 → 留 undefined 回退 stock_qty==0。
      let recentStockoutFreq: Map<string, number> | null | undefined;
      if (wantSubstitute && customer_id) {
        const hasPos = await getCustomerHasPos(customer_id);
        if (hasPos) recentStockoutFreq = await fetchRecentStockoutFreq(customer_id);
      }
      inlinePairs = computeInlinePairs({
        specs,
        enableUpgrade: wantUpgrade,
        enableSubstitute: wantSubstitute,
        extendedMap: await getExtendedCategoryMap(),
        onSaleIds,
        inventoryById: inv ?? new Map(),
        recentStockoutFreq,
        customerId: customer_id,
      });
    }

    // ---- 校验初始 zonePlacements 落位的柜台合法 ----
    for (const p of initialZonePlacements) {
      const target = displayCounters.find((c: any) => c.id === p.counterId);
      if (!target) {
        const body: GenerateResponse = {
          success: false,
          error: `专区分配的柜台 ${p.counterId} 不存在或非前柜/吊柜`,
        };
        res.status(400).json(body);
        return;
      }
    }

    // ---- 分配 regular specs:按"本次生成是否有展示柜专区"分流 ----
    // 这是新客户 / 常规客户两套陈列逻辑的解耦切点:
    //  - 无专区(新客户永远无专区,或常规/manual 未启用专区):还原归档版"铺满整柜"算法
    //    —— 按容量比例分配多柜台 + 每柜用满所有层 + 稀疏时双包,避免烟包挤顶部、底部留空。
    //  - 有专区(常规客户启用了专区):顺序分配,前置柜台先吃满,底部空行留给专区。
    const specCount = specs.length;
    const noDisplayZones = initialZonePlacements.length === 0;
    const allocations: number[] = [];
    const regularRowsByCounter = new Map<string, number>();
    let regularLayout: RegularFillLayout | undefined;
    // 归档版布局判定结果(仅 noDisplayZones 分支产出),回填响应供前端"陈列说明"叙述
    let layoutInfo: GenerateLayout | undefined;

    // 用户在 zone-select 分配的初始 zone 行数(每柜)。专区模式下常规分配要**先给这些行让位**,
    // 否则常规(0.4 包间隙 → 每行容量降至 ~packsPerRow/1.4,需更多行)会吃掉用户的专区行而触发 400。
    const initialZoneRowsByCounter = new Map<string, number>();
    for (const p of initialZonePlacements) {
      initialZoneRowsByCounter.set(
        p.counterId,
        (initialZoneRowsByCounter.get(p.counterId) || 0) + p.rowCount,
      );
    }

    if (noDisplayZones) {
      // 归档版多柜台容量比例分配(容量按 effLevels 计 —— fixedTop 占用的行不计入常规容量)
      const caps = displayCounters.map((c: any) => Math.floor(c.length / PACK_WIDTH_CM) * effLevels(c));
      const totalCap = caps.reduce((a: number, b: number) => a + b, 0);
      if (specCount >= totalCap) {
        for (let i = 0; i < displayCounters.length; i++) allocations[i] = caps[i];
      } else {
        for (let i = 0; i < displayCounters.length; i++) {
          allocations[i] = totalCap > 0 ? Math.round((specCount * caps[i]) / totalCap) : 0;
        }
        // 四舍五入误差按容量从大到小的柜台优先 ±1 调整,并夹在 [0, cap] 内
        let diff = specCount - allocations.reduce((a, b) => a + b, 0);
        const order = caps.map((_: number, i: number) => i).sort((a: number, b: number) => caps[b] - caps[a]);
        let k = 0;
        const maxSteps = (order.length + 1) * (specCount + 1);
        let steps = 0;
        while (diff !== 0 && order.length > 0 && steps < maxSteps) {
          const idx = order[k % order.length];
          if (diff > 0 && allocations[idx] < caps[idx]) { allocations[idx]++; diff--; }
          else if (diff < 0 && allocations[idx] > 0) { allocations[idx]--; diff++; }
          k++; steps++;
        }
      }
      for (const c of displayCounters) regularRowsByCounter.set(c.id, effLevels(c));  // 铺满「fixedTop 之外」的所有层

      // 归档版三档布局判定(按品规稀疏度优化空隙,取代已废弃的 face-out 自适应排面填充):
      //  - specCount ≥ 总容量            → standard:uniform 分布,每行铺满,gap≈0
      //  - 总容量/2 ≤ specCount < 总容量  → expanded:单包 + staggered,空隙均匀撑满整行宽
      //  - specCount < 总容量/2           → double:每品规 ×2 双包,staggered,同 id 紧贴
      // imageGen 的 generateCounterImage / drawFlatRow 据此 mode 绘制。
      let mode: RegularFillLayout['mode'];
      if (specCount >= totalCap) mode = 'standard';
      else if (specCount * 2 >= totalCap) mode = 'expanded';
      else mode = 'double';
      regularLayout = { mode };
      // 回填布局判定:specCount 与判定同口径;specIds 去重供前端"未经销"排除
      layoutInfo = {
        mode,
        specCount,
        capacity: totalCap,
        specIds: [...new Set(specs.map(s => s.id))],
        filteredHotCount: filteredHotSpecs.length,  // >0 → 原始规格数超容量,已暂缓这些紧俏烟(specCount 为过滤后口径)
      };
    } else {
      // 专区模式:常规按"最小间隙容量"比例均衡分到各柜(把所有常规行视为一个空间,各柜密度一致),
      // 余量行留给底部专区。perRowCap 取 GAP_MIN(0.4 包)下每行可放数(≈ packsPerRow/1.4),
      // 避免前柜挤到无缝、后柜某行空旷(详见 imageGen placeUnitsClamped / 框架文档 §8.3)。
      const perRowCap = displayCounters.map((c: any) =>
        Math.max(1, Math.floor(Math.floor(c.length / PACK_WIDTH_CM) / 1.4)));
      // 各柜常规可用行 = effLevels - 用户已分配的 zone 行(给专区让位);容量 = perRowCap × 可用行
      const availRows = displayCounters.map((c: any) =>
        Math.max(0, effLevels(c) - (initialZoneRowsByCounter.get(c.id) || 0)));
      const caps = displayCounters.map((_c: any, i: number) => perRowCap[i] * availRows[i]);
      const totalCap = caps.reduce((a: number, b: number) => a + b, 0);
      if (specCount >= totalCap) {
        for (let i = 0; i < displayCounters.length; i++) allocations[i] = caps[i];
      } else {
        for (let i = 0; i < displayCounters.length; i++) {
          allocations[i] = totalCap > 0 ? Math.round((specCount * caps[i]) / totalCap) : 0;
        }
        // 四舍五入误差按容量从大到小的柜台优先 ±1,夹在 [0, cap]
        let diff = specCount - allocations.reduce((a, b) => a + b, 0);
        const order = caps.map((_: number, i: number) => i).sort((a: number, b: number) => caps[b] - caps[a]);
        let k = 0;
        const maxSteps = (order.length + 1) * (specCount + 1);
        let steps = 0;
        while (diff !== 0 && order.length > 0 && steps < maxSteps) {
          const idx = order[k % order.length];
          if (diff > 0 && allocations[idx] < caps[idx]) { allocations[idx]++; diff--; }
          else if (diff < 0 && allocations[idx] > 0) { allocations[idx]--; diff++; }
          k++; steps++;
        }
      }
      for (let i = 0; i < displayCounters.length; i++) {
        const c = displayCounters[i];
        regularRowsByCounter.set(
          c.id,
          perRowCap[i] > 0 ? Math.min(availRows[i], Math.ceil(allocations[i] / perRowCap[i])) : 0,
        );
      }
    }

    // ---- 校验:用户分配的 zone 行数必须落在「常规之外的空闲层」内(常规已先给 zone 让位,
    //      正常不触发;仅当用户分配的 zone 行 > 柜台可用层时才报错)----
    for (const c of displayCounters) {
      const zRows = initialZoneRowsByCounter.get(c.id) || 0;
      const regRows = regularRowsByCounter.get(c.id) || 0;
      const freeRows = effLevels(c) - regRows;  // 底部专区只能落在「常规 + fixedTop 之外」的空闲层
      if (zRows > freeRows) {
        const body: GenerateResponse = {
          success: false,
          error: `柜台 ${c.id} 仅剩 ${freeRows} 行可放专区,无法容纳 ${zRows} 行`,
        };
        res.status(400).json(body);
        return;
      }
    }

    // ---- 自动扩展:把每个柜台剩余空行用已启用的专区填满(groupCount 优先,上限即柜台空闲层数) ----
    // 传 effLevels 作为各柜台层数 —— fixedTop(工商共育)占用的顶部行不参与底部专区扩展。
    const bottomZonePlacements: ZonePlacement[] = autoExpandZonePlacements(
      initialZonePlacements,
      displayCounters.map((c: any) => ({ id: c.id, levels: effLevels(c) })),
      regularRowsByCounter,
    );
    // 顶部 fixedTop(工商共育) + 底部其它专区,合并供逐柜台渲染(同一柜台可能两者皆有)
    const zonePlacements: ZonePlacement[] = [...bottomZonePlacements, ...fixedTopPlacements];

    // 尝鲜专区落位盖章 highlightIds(店长推荐中心高亮的在售重点品规),供 imageGen 渲染 2×2 + 加宽
    if (managerPickIds.length > 0) {
      for (const p of zonePlacements) {
        if (p.zoneId === 'newProduct') p.highlightIds = managerPickIds;
      }
    }

    // ---- 拉价签:仅"客户售价 < 区域常卖价"的待升价规格才贴价签 ----
    // 价签是常规客户专属功能(基于客户成交价与区域常卖价对比),新客户走归档版不渲染。
    // 现在还要求用户在专区页勾选了「价签体检」开关(priceTagEnabled)才生效 —— 不勾则不查、不贴、不出入口。
    // 勾了但全部规格都卖到位(无偏低) → priceTagMap 为空 → 不贴价签、showPriceTag=false,前端也不显示价签助手入口。
    // 价签上印的是"区域常卖价"=建议上调到的目标价。
    const priceTagMap = new Map<string, number>();
    let showPriceTag = false;
    if (customer_id && !isNewCustomer && priceTagEnabled) {
      const hasPos = await getCustomerHasPos(customer_id);
      const priceCmp = await getCustomerPriceComparison(customer_id, hasPos);
      for (const r of priceCmp.rows) priceTagMap.set(r.spec_id, r.region_price);
      showPriceTag = priceCmp.belowCount > 0;
    }

    // ---- 逐柜台生成图片 ----
    const results: CounterResult[] = [];
    // 产品升级/平替 inlineRegular chip 占位(不占行,仅供 result 页 chip + 出样引导渲染)
    const inlinePlacements: ZonePlacement[] = [];
    let offset = 0;
    for (let i = 0; i < displayCounters.length; i++) {
      const cabinet = displayCounters[i];
      const cabinetSpecs = specs.slice(offset, offset + allocations[i]);
      const cabinetZones = zonePlacements.filter(p => p.counterId === cabinet.id);
      // zone usedSpecIds 也要并入,用于背柜主题匹配:遍历 groups 收集 primary + alternatives
      for (const p of cabinetZones) {
        for (const g of p.groups) {
          usedSpecIds.add(g.primary.id);
          for (const a of g.alternatives) usedSpecIds.add(a.id);
        }
      }
      // ---- 先生成本柜陈列图,同时拿到「专区局部特写」裁图(crops) ----
      const regRows = regularRowsByCounter.get(cabinet.id) || 0;
      const { imageUrl, crops } = await generateCounterImage(cabinet, cabinetSpecs, regRows, cabinetZones, priceTagMap, regularLayout, inlinePairs);
      results.push({
        counterId: cabinet.id,
        counterType: cabinet.type,
        imageUrl,
      });

      // 裁图归类:占行专区按 zoneId(整段行一张)、内嵌配对按主规格 id(每对一张)。
      const bandCropByZone = new Map<string, string>();
      const pairCropByPrimary = new Map<string, string>();
      for (const cr of crops) {
        if (cr.primaryId) pairCropByPrimary.set(cr.primaryId, cr.imageUrl);
        else bandCropByZone.set(cr.zoneId, cr.imageUrl);
      }
      // 占行专区的局部特写回填到落位(cabinetZones 元素即 zonePlacements 里的同一对象,随响应下发)。
      for (const p of cabinetZones) {
        const url = bandCropByZone.get(p.zoneId);
        if (url) p.cropImageUrl = url;
      }

      // 内嵌红框配对:统计本柜命中的主规格(在 cabinetSpecs 内),按 zoneId 汇总为 chip 占位 placement,
      // 每组带上该对的局部特写裁图(pairCropByPrimary),供 result → 助手气泡按组展示。
      // 主规格首次出现即记一对;副规格随主规格内嵌渲染,两者都并入 usedSpecIds。
      if (inlinePairs.size > 0) {
        const seenPid = new Set<string>();
        const groupsByZone = new Map<'productUpgrade' | 'substitute', { primary: Category; alternatives: Category[]; cropImageUrl?: string }[]>();
        for (const s of cabinetSpecs) {
          const pair = inlinePairs.get(s.id);
          if (!pair || seenPid.has(s.id)) continue;
          seenPid.add(s.id);
          usedSpecIds.add(s.id);
          usedSpecIds.add(pair.secondary.id);
          const arr = groupsByZone.get(pair.zoneId) || [];
          arr.push({ primary: s, alternatives: [pair.secondary], cropImageUrl: pairCropByPrimary.get(s.id) });
          groupsByZone.set(pair.zoneId, arr);
        }
        for (const [zoneId, groups] of groupsByZone) {
          const meta = ZONE_META[zoneId];
          inlinePlacements.push({
            zoneId,
            label: meta.label,
            counterId: cabinet.id,
            rowCount: 0,
            groups,
            displayMode: meta.displayMode,
            layoutKind: 'inlineRegular',
            barColor: meta.barColor,
            priorityRank: meta.priorityRank,
            groupCount: groups.length,
          });
        }
      }
      offset += allocations[i];
    }

    // ---- 背柜:节日季节专区优先(单图直出);未命中节日的背柜走主题图逻辑 ----
    // 节日命中的背柜跳过 back-cabinet-select 主题匹配,跟用户在 zone-select 上的"节日优先"约定一致。
    const festivalByBackCounter = new Map<string, FestivalId>();
    const festivalSpecByBackCounter = new Map<string, string>();  // counter → 用户单选的商品 spec_id(可选)
    for (const a of backCabinetAssignments) {
      if (a.zone_id === 'festivalSeason' && a.festival_id) {
        festivalByBackCounter.set(a.counter_id, a.festival_id);
        if (a.festival_spec_id) festivalSpecByBackCounter.set(a.counter_id, a.festival_spec_id);
      }
    }
    let extendedMap: ReadonlyMap<string, Category> | null = null;
    if (festivalByBackCounter.size > 0) {
      extendedMap = await getExtendedCategoryMap();
    }
    const customerSpecIds = new Set(specs.map((c: Category) => c.id));

    const matchedThemes = allThemes.filter(
      t => t.specIds.some(id => usedSpecIds.has(id))
    );
    const allThemeImages = matchedThemes.flatMap(
      t => t.images.map(img => IMAGE_PREFIX + img)
    );

    // 背柜去重:不同背柜之间不复用同一张图。
    //  - festival 路径:usedFestivalImages 收集已用 URL,传给 selectFestivalImage 作 exclude
    //  - theme 路径:globalThemeCursor 跨柜台累加,每个柜台取连续不重叠的一段
    // 节日图(/images/back-festival/...) 与主题图(/images/back-themes/...) 目录不同无交叉,
    // 各在自己命名空间内去重即可。
    // 柜台内的层重复仍允许 —— 图源耗尽时必须循环;节日是"整柜单图"的设计语义。
    //
    // 新/常规客户共用此跨柜去重策略 —— 用户明确要求新客户也保留背柜去重。
    const usedFestivalImages = new Set<string>();
    let globalThemeCursor = 0;

    for (const counter of backCounters) {
      const festivalId = festivalByBackCounter.get(counter.id);
      if (festivalId && extendedMap) {
        const festivalUrl = await selectFestivalImage(
          festivalId,
          customerSpecIds,
          extendedMap,
          new Date(),
          usedFestivalImages,
          festivalSpecByBackCounter.get(counter.id),  // 用户单选的商品(可选);命中则优先用其礼盒图
        );
        if (festivalUrl) {
          usedFestivalImages.add(festivalUrl);
          results.push({
            counterId: counter.id,
            counterType: counter.type,
            imageUrl: festivalUrl,
            layerImages: [festivalUrl],
          });
          continue;
        }
        // 选不到图(目录空 / 候选与客户无交集 / 已被其他背柜用完): 降级走主题图逻辑
      }

      const layerImages: string[] = [];
      if (allThemeImages.length > 0) {
        for (let li = 0; li < counter.levels; li++) {
          layerImages.push(allThemeImages[(globalThemeCursor + li) % allThemeImages.length]);
        }
        globalThemeCursor += counter.levels;
      }
      results.push({
        counterId: counter.id,
        counterType: counter.type,
        imageUrl: layerImages.length > 0 ? layerImages[0] : 'mock:back',
        layerImages,
      });
    }

    // ---- 合并 festivalSeason 的 ZonePlacement 到响应 zonePlacements ----
    // selection 不知道 festivalSeason 的存在,这里单独构造占位 placement 供前端 result chip 展示。
    const festivalPlacements: ZonePlacement[] = [];
    const festivalMeta = ZONE_META.festivalSeason;
    for (const a of backCabinetAssignments) {
      if (a.zone_id === 'festivalSeason' && a.festival_id) {
        festivalPlacements.push({
          zoneId: 'festivalSeason',
          label: festivalMeta.label,
          counterId: a.counter_id,
          rowCount: 1,
          groups: [],
          displayMode: 'backFestival',
          barColor: festivalMeta.barColor,
          priorityRank: festivalMeta.priorityRank,
          groupCount: 1,
          festivalId: a.festival_id,
        });
      }
    }
    const allZonePlacements = [...zonePlacements, ...inlinePlacements, ...festivalPlacements];

    const body: GenerateResponse = {
      success: true,
      results,
      ...(filteredHotSpecs.length > 0 ? { filteredHotSpecs } : {}),
      ...(allZonePlacements.length > 0 ? { zonePlacements: allZonePlacements } : {}),
      ...(layoutInfo ? { layout: layoutInfo } : {}),
      ...(showPriceTag ? { showPriceTag: true } : {}),
    };
    res.json(body);
  } catch (err) {
    console.error('Generate error:', err);
    const message = err instanceof Error ? err.message : '图片生成失败';
    const body: GenerateResponse = { success: false, error: message };
    res.status(500).json(body);
  }
});

export default router;
