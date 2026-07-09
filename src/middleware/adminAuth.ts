import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * 后台管理接口鉴权：请求头 `X-Admin-Token` 必须等于环境变量 `ADMIN_TOKEN`。
 *
 * - **Fail-closed**：未配置 ADMIN_TOKEN → 一律 503，强制运维先设令牌（避免"忘了设=全开放"）。
 * - 定长比较（timingSafeEqual）防时序侧信道。
 * - 仅挂在 `/api/admin`，不影响小程序用的 `/api/*` 产品接口。
 *
 * 令牌下发：PM2 注入环境变量，例如
 *   ADMIN_TOKEN=<强随机串> pm2 restart counter-server --update-env
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    res.status(503).json({ success: false, error: '后台未配置 ADMIN_TOKEN，管理接口暂不可用' });
    return;
  }

  const provided = req.header('X-Admin-Token') || '';
  if (!safeEqual(provided, expected)) {
    res.status(401).json({ success: false, error: '令牌无效或缺失' });
    return;
  }

  next();
}

/** 定长安全比较；长度不等直接 false（不泄露长度差异导致的时序）。 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
