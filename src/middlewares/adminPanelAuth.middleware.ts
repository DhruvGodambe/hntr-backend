import { Request, Response, NextFunction } from 'express';
import { ENV } from '../config/env';
import { AdminAuthService } from '../services/adminAuth.service';
import { sendError } from '../utils/response';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      isAdminPanel?: boolean;
    }
  }
}

export function requireAdminPanelAuth(req: Request, res: Response, next: NextFunction): void {
  if (!AdminAuthService.isConfigured()) {
    sendError(res, 'Admin panel is disabled: ADMIN_PASSWORD is not configured on the server.', 503);
    return;
  }

  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;

  if (!token) {
    sendError(res, 'Admin authentication required.', 401);
    return;
  }

  try {
    AdminAuthService.verifyToken(token);
    req.isAdminPanel = true;
    next();
  } catch {
    sendError(res, 'Invalid or expired admin session. Please sign in again.', 401);
  }
}

/**
 * Extra guard for routes that move real funds on-chain.
 * Accepts either a valid admin JWT (issued after password login) OR the legacy
 * x-admin-secret header so existing automation scripts keep working.
 */
export function requireAdminPrivileged(req: Request, res: Response, next: NextFunction): void {
  const secretHeader = req.headers['x-admin-secret'];
  if (ENV.ADMIN_SECRET && secretHeader === ENV.ADMIN_SECRET) {
    req.isAdminPanel = true;
    next();
    return;
  }

  requireAdminPanelAuth(req, res, next);
}
