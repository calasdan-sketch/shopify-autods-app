import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Bearer-token guard for /admin. FAILS CLOSED: with no ADMIN_TOKEN set (or one
 * shorter than 16 chars) every admin request is refused with 503, so a
 * forgotten setting can never expose orders and customer addresses.
 */
export function adminAuth(token: string) {
  const usable = token.length >= 16;
  const want = Buffer.from(token);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!usable) {
      res
        .status(503)
        .json({ error: 'admin disabled: set ADMIN_TOKEN (min 16 chars)' });
      return;
    }
    const header = req.get('authorization') ?? '';
    const got = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
