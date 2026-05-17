import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface SeasonRow extends RowDataPacket {
  season_key: string;
  category: '季节' | '节日';
  label: string;
  start_date: Date | string;
  end_date: Date | string;
  rules: string | null;
}

function toDateStr(d: Date | string): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}

/** GET /api/active-seasons — 当前生效的季节 / 节日
 *
 * 查询参数：
 *  - date=2026-05-17  可选，默认服务器当前日期
 *
 * 返回所有 start_date ≤ date ≤ end_date 的记录，并合并它们的 rules（去重）。
 * 前端可用 rules 决策展示顺序（高价烟前置 / 沪产专区前置 等）。
 */
router.get('/', async (req: Request, res: Response) => {
  const dateParam = (req.query.date as string) || new Date().toISOString().slice(0, 10);

  try {
    const [rows] = await pool.execute<SeasonRow[]>(
      `SELECT season_key, category, label, start_date, end_date, rules
         FROM sys_season_calendar
        WHERE ? BETWEEN start_date AND end_date
        ORDER BY FIELD(category, '节日', '季节')`,
      [dateParam]
    );

    const allRules = new Set<string>();
    for (const r of rows) {
      if (r.rules) {
        for (const rule of r.rules.split(',')) {
          const trimmed = rule.trim();
          if (trimmed) allRules.add(trimmed);
        }
      }
    }

    res.json({
      success: true,
      date: dateParam,
      seasons: rows.map(r => ({
        season_key: r.season_key,
        category: r.category,
        label: r.label,
        start_date: toDateStr(r.start_date),
        end_date: toDateStr(r.end_date),
        rules: r.rules ? r.rules.split(',').map(s => s.trim()).filter(Boolean) : [],
      })),
      merged_rules: Array.from(allRules),
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      res.json({ success: true, date: dateParam, seasons: [], merged_rules: [] });
      return;
    }
    console.error('Query active-seasons error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
