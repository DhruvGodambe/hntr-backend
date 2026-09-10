import { Router, Request, Response, NextFunction } from 'express';
import { turnstileVerifyRateLimit } from '../middlewares/rateLimiter.middleware';
import { sendError, sendSuccess } from '../utils/response';
import {
  clientIpFrom,
  isTurnstileEnforced,
  turnstileTokenFrom,
  verifyTurnstileToken,
} from '../services/turnstile.service';

const router = Router();

/**
 * Standalone token check for the front-end "verify you are human" site gate.
 * The gate shows the widget on first visit and calls this once with the token;
 * a success lets the visitor into the site.
 *
 * `enforced: false` tells the client the server has no secret configured, so the
 * gate should let everyone through (local dev / preview).
 */
router.get('/config', (_req: Request, res: Response) => {
  sendSuccess(res, { enforced: isTurnstileEnforced() }, 'Turnstile config');
});

router.post('/verify', turnstileVerifyRateLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isTurnstileEnforced()) {
      sendSuccess(res, { verified: true, enforced: false }, 'Human verification not enforced');
      return;
    }
    const result = await verifyTurnstileToken(turnstileTokenFrom(req), clientIpFrom(req));
    if (result.ok) {
      sendSuccess(res, { verified: true, enforced: true }, 'Human verification passed');
      return;
    }
    sendError(res, result.message, result.status, { code: result.code });
  } catch (err) {
    next(err);
  }
});

export default router;
