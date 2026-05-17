import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface RuleRow extends RowDataPacket {
  id: number;
  spec_id_a: string;
  spec_id_b: string;
  target_type: string;
  rule_type: string;
  co_users: number | null;
  support: string | null;
  confidence: string | null;
  lift: string | null;
  switch_users: number | null;
  cat_score: string | null;
  final_score: string;
  rank_in_a: number;
}

/** GET /api/substitute-recommend — 替代品规推荐
 *
 * 查询参数：
 *  - spec_id=110105        目标规格（必填）
 *  - limit=5               返回 Top N（默认 5）
 *  - target_type=stockout  可选过滤：仅匹配该目标类型的规则（CSV 里 target_type 是逗号分隔多值，用 FIND_IN_SET 匹配）
 *
 * 用于：脱销规格的平替推荐、退市规格的怀旧替代、滞销规格的横向对比。
 */
router.get('/', async (req: Request, res: Response) => {
  const specId = req.query.spec_id as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 5, 20);
  const targetType = req.query.target_type as string | undefined;

  if (!specId) {
    res.status(400).json({ success: false, error: 'spec_id 不能为空' });
    return;
  }

  const conditions = ['spec_id_a = ?'];
  const params: (string | number)[] = [specId];

  if (targetType) {
    conditions.push('FIND_IN_SET(?, target_type) > 0');
    params.push(targetType);
  }

  try {
    const [rows] = await pool.execute<RuleRow[]>(
      `SELECT id, spec_id_a, spec_id_b, target_type, rule_type,
              co_users, support, confidence, lift,
              switch_users, cat_score, final_score, rank_in_a
         FROM ref_co_purchase_rules
        WHERE ${conditions.join(' AND ')}
        ORDER BY rank_in_a ASC
        LIMIT ${limit}`,
      params
    );

    res.json({
      success: true,
      target_spec_id: specId,
      recommendations: rows.map(r => ({
        spec_id: r.spec_id_b,
        rank: r.rank_in_a,
        rule_type: r.rule_type,
        target_type: r.target_type,
        final_score: Number(r.final_score),
        co_users: r.co_users,
        switch_users: r.switch_users,
        lift: r.lift ? Number(r.lift) : null,
        confidence: r.confidence ? Number(r.confidence) : null,
      })),
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      res.json({ success: true, target_spec_id: specId, recommendations: [] });
      return;
    }
    console.error('Query substitute-recommend error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
