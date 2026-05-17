import { Router, Request, Response } from 'express';
import pool from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface ScriptRow extends RowDataPacket {
  id: number;
  scene: string;
  target_type: 'spec' | 'tag' | 'brand';
  target_value: string;
  script_text: string;
}

type Scene = '滞销夸夸' | '新品推荐' | '怀旧专区' | '沪产专区' | '礼盒精品';

/** GET /api/praise-script — 经营话术
 *
 * 查询参数（至少传一个）：
 *  - spec_id=110105  → 优先匹配 target_type=spec 的话术
 *  - brand=中华      → 匹配 target_type=brand
 *  - tag=细支        → 匹配 target_type=tag
 *  - scene=怀旧专区  → 限定场景
 *
 * 匹配优先级：spec > brand > tag
 * 返回所有匹配的话术（前端可随机挑一条）。
 */
router.get('/', async (req: Request, res: Response) => {
  const specId = req.query.spec_id as string | undefined;
  const brand = req.query.brand as string | undefined;
  const tag = req.query.tag as string | undefined;
  const scene = req.query.scene as Scene | undefined;

  if (!specId && !brand && !tag) {
    res.status(400).json({ success: false, error: '至少传 spec_id / brand / tag 之一' });
    return;
  }

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  const orParts: string[] = [];
  if (specId) {
    orParts.push('(target_type = ? AND target_value = ?)');
    params.push('spec', specId);
  }
  if (brand) {
    orParts.push('(target_type = ? AND target_value = ?)');
    params.push('brand', brand);
  }
  if (tag) {
    orParts.push('(target_type = ? AND target_value = ?)');
    params.push('tag', tag);
  }
  conditions.push(`(${orParts.join(' OR ')})`);

  if (scene) {
    conditions.push('scene = ?');
    params.push(scene);
  }

  try {
    // 优先级排序：spec(1) > brand(2) > tag(3)
    const [rows] = await pool.execute<ScriptRow[]>(
      `SELECT id, scene, target_type, target_value, script_text
         FROM sys_praise_scripts
        WHERE ${conditions.join(' AND ')}
        ORDER BY FIELD(target_type, 'spec', 'brand', 'tag'), id`,
      params
    );

    res.json({ success: true, scripts: rows });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE') {
      res.json({ success: true, scripts: [] });
      return;
    }
    console.error('Query praise-script error:', err);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

export default router;
