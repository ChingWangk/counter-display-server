/**
 * 后台管理平台「表注册表」—— 通用数据 API 的唯一真源 / 安全白名单。
 *
 * 设计要点：
 *  - 只有登记在此的表允许被后台查询 / 导出 / 导入（杜绝任意表访问）。
 *  - **列不在此硬编码**：查询/导入时由 `information_schema.COLUMNS` 运行时自省真实列，
 *    这样加列/改列无需同步维护本文件，且 orderBy/搜索/导入映射都以真实列为准。
 *  - 本表只登记「元数据」：主键(逻辑唯一键)、维护节奏、是否进维护台、默认导入策略、
 *    敏感列(永不返回/导出/导入)、新鲜度取数口径。
 */

export type Cadence =
  | 'monthly'    // 每月快照
  | 'quarterly'  // 每季快照
  | 'yearly'     // 年度维护
  | 'manual'     // 运营不定期手工维护
  | 'mined'      // 挖掘/ETL 产出（勿手工导入）
  | 'api';       // 由业务接口事件驱动 upsert（一般不进维护台）

export type ImportMode = 'upsert' | 'replace' | 'append' | 'readonly';

/** 维护台「新鲜度」取数：以受信注册表表达式取最新标记（非用户输入，无注入风险）。 */
export interface TableFreshness {
  unit: '月' | '季' | '日';
  /** SELECT 的表达式，取一行代表"最新"，如 `snapshot_month` 或 `CONCAT(year,'/Q',quarter)` */
  select: string;
  /** ORDER BY 片段（降序取最新），如 `snapshot_month` 或 `year, quarter` */
  order: string;
}

export interface AdminTable {
  /** URL slug，等于真实表名 */
  key: string;
  table: string;
  label: string;
  category: 'customer' | 'goods' | 'rule' | 'market';
  /** 逻辑唯一键（upsert 的碰撞键；自增 surrogate id 不算） */
  keyColumns: string[];
  cadence: Cadence;
  /** 是否进「维护台」重点高亮（需定期更新的表） */
  managed: boolean;
  /** 默认导入策略；readonly = 不允许导入 */
  importMode: ImportMode;
  /** 是否允许 Excel 导入 */
  importable: boolean;
  /** 敏感列：查询/导出/导入全链路剔除（如明文密码） */
  sensitiveColumns?: string[];
  /** 覆盖默认搜索列（默认=所有字符串列） */
  searchable?: string[];
  /** 默认排序列（缺省取首个 keyColumn） */
  defaultOrderBy?: string;
  /** 维护台新鲜度口径（仅部分快照表有） */
  freshness?: TableFreshness;
  note?: string;
}

export const ADMIN_TABLES: AdminTable[] = [
  // ---------------- 客户数据中心 ----------------
  {
    key: 'cust_info', table: 'cust_info', label: '客户档案', category: 'customer',
    keyColumns: ['customer_id'], cadence: 'api', managed: false,
    importMode: 'upsert', importable: true,
    sensitiveColumns: ['login_password'],  // 明文密码：永不返回/导出/导入
    searchable: ['customer_id', 'customer_name', 'district'],
    note: '客户基本信息 + grade 档位。导入按 customer_id 增量合并，不删旧客户；密码列全链路剔除。',
  },
  {
    key: 'cust_counters', table: 'cust_counters', label: '柜台台账', category: 'customer',
    keyColumns: ['counter_id'], cadence: 'api', managed: false,
    importMode: 'upsert', importable: true,
    searchable: ['customer_id', 'counter_id', 'type'],
    note: 'counter_id 全局唯一，按其增量合并。',
  },
  {
    key: 'cust_inventory', table: 'cust_inventory', label: '进销存快照', category: 'customer',
    keyColumns: ['customer_id', 'spec_id', 'snapshot_date'], cadence: 'monthly', managed: true,
    importMode: 'upsert', importable: true,
    searchable: ['customer_id', 'spec_id'],
    freshness: { unit: '日', select: 'snapshot_date', order: 'snapshot_date' },
    note: '滞销/脱销判定依赖此表，每月对接进销存。',
  },
  {
    key: 'customer_specs', table: 'customer_specs', label: '主营品规', category: 'customer',
    keyColumns: ['customer_id'], cadence: 'api', managed: false,
    importMode: 'upsert', importable: true,
    searchable: ['customer_id'],
    note: 'spec_detail 为逗号分隔品规串；一般由 POST /api/customer-specs upsert。',
  },

  // ---------------- 商品与陈列资源 ----------------
  {
    key: 'dim_category_ext', table: 'dim_category_ext', label: '品规维度扩展', category: 'goods',
    keyColumns: ['spec_id'], cadence: 'quarterly', managed: true,
    importMode: 'upsert', importable: true,
    searchable: ['spec_id', 'pack_type', 'flavor', 'tier'],
    note: 'pack_type/flavor/tier/launch_date/is_delisted/successor 等业务维度，季度维护。',
  },

  // ---------------- 智能规则中心 ----------------
  {
    key: 'ondemand_supply_specs', table: 'ondemand_supply_specs', label: '按需供应规格', category: 'rule',
    keyColumns: ['spec_id', 'grade'], cadence: 'manual', managed: true,
    importMode: 'replace', importable: true,
    searchable: ['spec_id', 'grade', 'policy'],
    note: '“只要订购即供”的可扩品清单，整表替换（先自动备份）。',
  },
  {
    key: 'sys_praise_scripts', table: 'sys_praise_scripts', label: '经营话术库', category: 'rule',
    keyColumns: ['id'], cadence: 'manual', managed: true,
    importMode: 'append', importable: true,
    searchable: ['scene', 'target_type', 'target_value', 'script_text'],
    note: '话术库，追加式维护（append），不覆盖历史。',
  },
  {
    key: 'sys_season_calendar', table: 'sys_season_calendar', label: '季节/节日日历', category: 'rule',
    keyColumns: ['season_key'], cadence: 'yearly', managed: true,
    importMode: 'replace', importable: true,
    searchable: ['season_key', 'label', 'category'],
    note: '次年前整表更新。',
  },
  {
    key: 'agent_feedback', table: 'agent_feedback', label: '助手回答反馈', category: 'rule',
    keyColumns: ['id'], cadence: 'api', managed: false,
    importMode: 'readonly', importable: false,
    searchable: ['agent_id', 'customer_id', 'question', 'feedback'],
    defaultOrderBy: 'created_at',
    note: '小程序对话里用户对回答的点赞/点踩，只读回收，用于修正话术；由前端事件写入。',
  },
  {
    key: 'ref_co_purchase_rules', table: 'ref_co_purchase_rules', label: '连带/平替规则', category: 'rule',
    keyColumns: ['id'], cadence: 'mined', managed: false,
    importMode: 'readonly', importable: false,
    searchable: ['scope', 'spec_id_a', 'spec_id_b', 'rule_type'],
    note: 'FP-Growth 挖掘产出，由离线脚本重跑刷新，勿手工导入。',
  },

  // ---------------- 市场参考数据 ----------------
  {
    key: 'ref_yangpu_avg_price', table: 'ref_yangpu_avg_price', label: '区域均价与价签', category: 'market',
    keyColumns: ['spec_id', 'snapshot_month'], cadence: 'monthly', managed: true,
    importMode: 'upsert', importable: true,
    searchable: ['spec_id', 'spec_name'],
    freshness: { unit: '月', select: 'snapshot_month', order: 'snapshot_month' },
    note: '杨浦区月度均价 + 价签白名单。',
  },
  {
    key: 'ref_yangpu_stockout', table: 'ref_yangpu_stockout', label: '区域脱销名单', category: 'market',
    keyColumns: ['spec_id'], cadence: 'mined', managed: false,
    importMode: 'readonly', importable: false,
    searchable: ['spec_id', 'spec_name'],
    note: '挖掘产出（依赖最新库存），勿手工导入。',
  },
  {
    key: 'ref_market_coverage', table: 'ref_market_coverage', label: '铺市面率', category: 'market',
    keyColumns: ['spec_id', 'snapshot_month'], cadence: 'monthly', managed: true,
    importMode: 'upsert', importable: true,
    searchable: ['spec_id', 'spec_name'],
    freshness: { unit: '月', select: 'snapshot_month', order: 'snapshot_month' },
  },
  {
    key: 'ref_order_fill_rate', table: 'ref_order_fill_rate', label: '订足率', category: 'market',
    keyColumns: ['spec_id', 'snapshot_month'], cadence: 'monthly', managed: true,
    importMode: 'upsert', importable: true,
    searchable: ['spec_id', 'spec_name'],
    freshness: { unit: '月', select: 'snapshot_month', order: 'snapshot_month' },
  },
  {
    key: 'ref_quarterly_wholesale_rank', table: 'ref_quarterly_wholesale_rank', label: '季度批发排名', category: 'market',
    keyColumns: ['spec_id', 'year', 'quarter'], cadence: 'quarterly', managed: true,
    importMode: 'upsert', importable: true,
    searchable: ['spec_id', 'spec_name'],
    freshness: { unit: '季', select: "CONCAT(year,'/Q',quarter)", order: 'year, quarter' },
  },
  {
    key: 'ref_local_brand_growth', table: 'ref_local_brand_growth', label: '沪产烟增长', category: 'market',
    keyColumns: ['spec_id', 'year', 'quarter'], cadence: 'quarterly', managed: true,
    importMode: 'upsert', importable: true,
    searchable: ['spec_id', 'spec_name'],
    freshness: { unit: '季', select: "CONCAT(year,'/Q',quarter)", order: 'year, quarter' },
  },
];

const BY_KEY = new Map<string, AdminTable>(ADMIN_TABLES.map(t => [t.key, t]));

export function getAdminTable(key: string): AdminTable | undefined {
  return BY_KEY.get(key);
}
