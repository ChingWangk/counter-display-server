import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket } from 'mysql2';
import { getExtendedCategoryMap } from '../services/categoryCatalog';

/**
 * 按需供应规格（ondemand_supply_specs）：这些规格“只要订购即可获得供应”，
 * 用于向客户（尤其新客户）推荐可扩充的经营品规。数据由运营侧维护（CSV / LOAD DATA 导入，见落库文档）。
 *
 * 两个接口：
 *  - GET /api/ondemand-specs           列出全部（后台管理只读卡片用）
 *  - GET /api/ondemand-specs/recommend 推荐“客户未经销”的按需供应规格（结合客户档位）
 *
 * 全程“数据缺失即静默降级、绝不编造”：表 / 字段未就绪一律当作空结果处理。
 */

const router = Router();

interface OndemandRow extends RowDataPacket {
  spec_id: string;
  grade: string | null;
  policy: string | null;
  sort_order: number;
  note: string | null;
}

/** MySQL 错误码：表不存在 / 字段不存在（表或列尚未就绪时容错用）。 */
function errCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

/** GET /api/ondemand-specs — 列出全部按需供应规格（后台只读卡片）。表未就绪 → 空。 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool.execute<OndemandRow[]>(
      `SELECT spec_id, grade, policy, sort_order, note
         FROM ondemand_supply_specs
        ORDER BY sort_order ASC, spec_id ASC`,
    );
    const catMap = await getExtendedCategoryMap();
    const specs = rows.map(r => ({
      spec_id: r.spec_id,
      spec_name: catMap.get(r.spec_id)?.name || r.spec_id,
      grade: r.grade,
      policy: r.policy,
      sort_order: r.sort_order,
      note: r.note,
    }));
    res.json({ success: true, specs });
  } catch (err) {
    if (errCode(err) === 'ER_NO_SUCH_TABLE') {
      res.json({ success: true, specs: [] });
      return;
    }
    console.error('List ondemand-specs error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

/**
 * GET /api/ondemand-specs/recommend?customer_id=&exclude_ids=a,b[&limit=]
 * 推荐“客户未经销”的按需供应规格：
 *   1. 客户档位 = cust_info.grade（表/字段未就绪 → 视为未知）
 *   2. 排除集 = 客户主营品规(customer_specs.spec_detail) ∪ exclude_ids(本次陈列已展示)
 *   3. 候选 = ondemand_supply_specs 中 (grade = 客户档位 OR grade IS NULL)；档位未知则取全部
 *   4. 去掉排除集，按 sort_order 排序全部返回（有多少推多少）；传正整数 limit 才截断；规格名由品类目录解析
 */
router.get('/recommend', async (req: Request, res: Response) => {
  const customerId = String(req.query.customer_id || '').trim();
  const excludeParam = String(req.query.exclude_ids || '').trim();
  // 默认不限量（有多少推多少）；仅当显式传正整数 limit 时才截断。
  const rawLimit = parseInt(String(req.query.limit || ''), 10);
  const limit = rawLimit > 0 ? rawLimit : Infinity;

  try {
    // 1) 客户档位
    let grade: string | null = null;
    if (customerId) {
      try {
        const [r] = await pool.execute<RowDataPacket[]>(
          'SELECT grade FROM cust_info WHERE customer_id = ?',
          [customerId],
        );
        if (r.length > 0) grade = ((r[0] as { grade?: string | null }).grade ?? null) || null;
      } catch (e) {
        // 表未建 / grade 列未加 → 档位未知，继续走全量
        if (errCode(e) !== 'ER_NO_SUCH_TABLE' && errCode(e) !== 'ER_BAD_FIELD_ERROR') throw e;
      }
    }

    // 2) 排除集：本次展示 ∪ 主营品规
    const exclude = new Set<string>();
    for (const id of excludeParam.split(',').map(s => s.trim()).filter(Boolean)) exclude.add(id);
    if (customerId) {
      try {
        const [r] = await pool.execute<RowDataPacket[]>(
          'SELECT spec_detail FROM customer_specs WHERE customer_id = ?',
          [customerId],
        );
        const detail = r.length > 0 ? (r[0] as { spec_detail?: string | null }).spec_detail : null;
        if (detail) for (const id of detail.split(',').map(s => s.trim()).filter(Boolean)) exclude.add(id);
      } catch (e) {
        if (errCode(e) !== 'ER_NO_SUCH_TABLE') throw e;
      }
    }

    // 3) 候选按需供应规格（结合档位）
    let rows: OndemandRow[] = [];
    try {
      if (grade) {
        const [rr] = await pool.execute<OndemandRow[]>(
          `SELECT spec_id, grade, policy, sort_order, note
             FROM ondemand_supply_specs
            WHERE grade = ? OR grade IS NULL
            ORDER BY sort_order ASC, spec_id ASC`,
          [grade],
        );
        rows = rr;
      } else {
        const [rr] = await pool.execute<OndemandRow[]>(
          `SELECT spec_id, grade, policy, sort_order, note
             FROM ondemand_supply_specs
            ORDER BY sort_order ASC, spec_id ASC`,
        );
        rows = rr;
      }
    } catch (e) {
      if (errCode(e) === 'ER_NO_SUCH_TABLE') rows = [];
      else throw e;
    }

    // 4) 去排除集 + 去重 + 截断 + 解析规格名
    const catMap = await getExtendedCategoryMap();
    const seen = new Set<string>();
    const recommendations: { spec_id: string; name: string; policy: string | null }[] = [];
    for (const r of rows) {
      if (exclude.has(r.spec_id) || seen.has(r.spec_id)) continue;
      seen.add(r.spec_id);
      recommendations.push({
        spec_id: r.spec_id,
        name: catMap.get(r.spec_id)?.name || r.spec_id,
        policy: r.policy,
      });
      if (recommendations.length >= limit) break;
    }

    res.json({ success: true, grade, recommendations });
  } catch (err) {
    console.error('Ondemand recommend error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
