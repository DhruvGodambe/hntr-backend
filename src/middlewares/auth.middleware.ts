import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import { sendError } from '../utils/response';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      walletAddress?: string;
    }
  }
}

/**
 * Requires a valid session token (issued via /api/auth/nonce + /api/auth/verify) and
 * attaches the authenticated wallet address to `req.walletAddress`. Every relay
 * endpoint (membership purchase/upgrade, commission claim) MUST use this instead of
 * trusting a `walletAddress` field from the request body, otherwise anyone could make
 * the burner wallet spend gas relaying transactions "for" an arbitrary address.
 */
export function requireWalletAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;

  if (!token) {
    sendError(res, 'Authentication required. Sign in with your wallet first.', 401);
    return;
  }

  try {
    const payload = AuthService.verifyToken(token);
    req.walletAddress = payload.walletAddress;
    next();
  } catch {
    sendError(res, 'Invalid or expired session. Please sign in again.', 401);
  }
}
