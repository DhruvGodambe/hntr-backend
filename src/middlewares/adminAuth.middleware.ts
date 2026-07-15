import { Request, Response, NextFunction } from 'express';
import { ENV } from '../config/env';
import { sendError } from '../utils/response';

/**
 * Guards admin routes that can move real funds (e.g. manually triggering the
 * leadership payout run) behind a shared secret passed via the `x-admin-secret`
 * header. If ADMIN_SECRET isn't configured, these routes always reject - there's
 * no "open by default" fallback.
 */
export function requireAdminSecret(req: Request, res: Response, next: NextFunction): void {
  if (!ENV.ADMIN_SECRET) {
    sendError(res, 'Admin routes are disabled: ADMIN_SECRET is not configured on the server.', 503);
    return;
  }
  const provided = req.headers['x-admin-secret'];
  if (provided !== ENV.ADMIN_SECRET) {
    sendError(res, 'Unauthorized', 401);
    return;
  }
  next();
}
