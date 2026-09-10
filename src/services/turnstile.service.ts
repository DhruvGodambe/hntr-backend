import { Request } from 'express';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** True when TURNSTILE_SECRET is set, i.e. the server actually checks tokens. */
export function isTurnstileEnforced(): boolean {
  return Boolean(ENV.TURNSTILE_SECRET);
}

/** Best-effort client IP for the optional `remoteip` siteverify param. */
export function clientIpFrom(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.ip || '';
}

/** Pull the token from the JSON body (`turnstileToken`/`token`) or the header. */
export function turnstileTokenFrom(req: Request): string {
  const body = req.body ?? {};
  if (typeof body.turnstileToken === 'string' && body.turnstileToken) return body.turnstileToken;
  if (typeof body.token === 'string' && body.token) return body.token;
  const header = req.headers['cf-turnstile-response'];
  if (typeof header === 'string' && header) return header;
  return '';
}

export type SiteverifyResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 503; code: string; message: string };

/**
 * Validate a Turnstile token against Cloudflare. Callers decide what a failure
 * means (block a request, or refuse to lift a site gate).
 */
export async function verifyTurnstileToken(token: string, remoteip?: string): Promise<SiteverifyResult> {
  const secret = ENV.TURNSTILE_SECRET;
  if (!secret) return { ok: true }; // not enforced — treat as pass (dev/Postman/CI)

  if (!token) {
    return {
      ok: false,
      status: 400,
      code: 'TURNSTILE_TOKEN_MISSING',
      message: 'Human verification required. Please complete the challenge and retry.',
    };
  }

  const form = new URLSearchParams();
  form.set('secret', secret);
  form.set('response', token);
  if (remoteip) form.set('remoteip', remoteip);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form, signal: controller.signal });
    const data = (await res.json()) as { success: boolean; 'error-codes'?: string[] };
    if (data.success) return { ok: true };
    logger.warn(`Turnstile verification failed: ${(data['error-codes'] || []).join(', ') || 'unknown'}`);
    return {
      ok: false,
      status: 403,
      code: 'TURNSTILE_VERIFICATION_FAILED',
      message: 'Human verification failed. Please refresh and try again.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Turnstile siteverify request error: ${msg}`);
    return {
      ok: false,
      status: 503,
      code: 'TURNSTILE_UNAVAILABLE',
      message: 'Could not reach the human-verification service. Please try again.',
    };
  } finally {
    clearTimeout(timeout);
  }
}
