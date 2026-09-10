import { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/response';
import {
  clientIpFrom,
  isTurnstileEnforced,
  turnstileTokenFrom,
  verifyTurnstileToken,
} from '../services/turnstile.service';

/**
 * Cloudflare Turnstile ("Verify you are human") server-side check.
 *
 * The browser widget produces a one-time token; the client sends it as
 * `turnstileToken` in the JSON body (or the `cf-turnstile-response` header).
 * This middleware validates it against Cloudflare before the request reaches
 * the controller.
 *
 * If TURNSTILE_SECRET is not configured the check is skipped entirely, so local
 * development, Postman and tests keep working without a token. Set the secret on
 * the Render service to enforce it in production.
 */
export function verifyTurnstile(req: Request, res: Response, next: NextFunction): void {
  if (!isTurnstileEnforced()) {
    next();
    return;
  }

  verifyTurnstileToken(turnstileTokenFrom(req), clientIpFrom(req))
    .then((result) => {
      if (result.ok) {
        next();
        return;
      }
      sendError(res, result.message, result.status, { code: result.code });
    })
    .catch((err) => next(err));
}
