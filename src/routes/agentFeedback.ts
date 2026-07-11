import { Router, Request, Response } from 'express';
import pool from '../db';
import { ResultSetHeader } from 'mysql2';

/**
 * 助手回答反馈（agent_feedback）：小程序对话里用户对某条"陈列说明/经营建议"回答点赞/点踩，
 * 回收后用于修正话术（文档"三项体验增强·反馈点评机制"）。
 *
 * 前端为"发了就忘"（fire-and-forget）：本地已即时反馈，此接口成功与否都不影响体验。
 * 因此表未建（ER_NO_SUCH_TABLE）时也返回 success:true，绝不 500 打扰用户。
 *
 * 建表 DDL（服务器一次性执行，见 docs/助手反馈-数据落库与维护.md）：
 *   CREATE TABLE IF NOT EXISTS agent_feedback (
 *     id BIGINT AUTO_INCREMENT PRIMARY KEY,
 *     agent_id    VARCHAR(32)  NOT NULL,           -- 助手 id（zone id / general / priceTag）
 *     customer_id VARCHAR(32)  DEFAULT NULL,
 *     question    VARCHAR(64)  DEFAULT NULL,       -- 问句（陈列说明 / 经营建议 / 自由提问）
 *     answer      TEXT         DEFAULT NULL,       -- 被评价的回答原文（便于比对修订）
 *     feedback    ENUM('up','down') NOT NULL,
 *     created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *     INDEX idx_agent (agent_id), INDEX idx_feedback (feedback)
 *   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
 */

const router = Router();

function errCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

/** 截断到列上限，避免超长 answer/question 触发写入错误。 */
function clip(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

/** POST /api/agent-feedback — 记录一条点赞/点踩。 */
router.post('/', async (req: Request, res: Response) => {
  const agentId = clip(req.body?.agentId, 32);
  const feedback = String(req.body?.feedback || '');
  if (!agentId || (feedback !== 'up' && feedback !== 'down')) {
    res.status(400).json({ success: false, error: '参数不合法' });
    return;
  }

  const customerId = clip(req.body?.customerId, 32);
  const question = clip(req.body?.question, 64);
  const answer = clip(req.body?.answer, 2000);

  try {
    await pool.execute<ResultSetHeader>(
      `INSERT INTO agent_feedback (agent_id, customer_id, question, answer, feedback)
       VALUES (?, ?, ?, ?, ?)`,
      [agentId, customerId, question, answer, feedback],
    );
    res.json({ success: true });
  } catch (err) {
    // 表未就绪：视为"已收到"，不打扰前端（前端本就 fire-and-forget）
    if (errCode(err) === 'ER_NO_SUCH_TABLE') {
      res.json({ success: true, stored: false });
      return;
    }
    console.error('Agent feedback insert error:', err);
    res.status(500).json({ success: false, error: '记录失败' });
  }
});

export default router;
