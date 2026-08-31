import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import { UserService } from '../services/user.service';
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

function sessionWallet(req: Request): string | undefined {
  return req.walletAddress?.toLowerCase();
}

/**
 * After requireWalletAuth: the path wallet must be the authenticated session wallet.
 * Knowledge of another address is not authorization (VAPT IDOR / BOLA).
 */
export function requireSelfWallet(param = 'walletAddress') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = sessionWallet(req);
    if (!session) {
      sendError(res, 'Authentication required. Sign in with your wallet first.', 401);
      return;
    }
    const requested = String(req.params[param] ?? '').toLowerCase();
    if (!requested || requested !== session) {
      sendError(res, 'You are not authorized to access this resource.', 403);
      return;
    }
    next();
  };
}

/**
 * After requireWalletAuth: the path username must belong to the authenticated wallet.
 */
export function requireSelfUsername(param = 'username') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = sessionWallet(req);
    if (!session) {
      sendError(res, 'Authentication required. Sign in with your wallet first.', 401);
      return;
    }
    const username = String(req.params[param] ?? '').trim();
    if (!username) {
      sendError(res, 'You are not authorized to access this resource.', 403);
      return;
    }
    try {
      const user = await UserService.getUserByUsername(username);
      if (!user) {
        sendError(res, 'User not found', 404);
        return;
      }
      if ((user.walletAddress || '').toLowerCase() !== session) {
        sendError(res, 'You are not authorized to access this resource.', 403);
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
