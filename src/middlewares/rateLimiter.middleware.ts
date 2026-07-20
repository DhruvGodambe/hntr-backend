import { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/response';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateLimitEntry>();

/** Periodically purge stale buckets so memory stays bounded. */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets.entries()) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}, 60_000);

function getClientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Lightweight in-memory sliding-window rate limiter.
 * Suitable for single-process deployments; swap for Redis-backed limiter when scaling horizontally.
 */
export function rateLimit(options: { windowMs: number; max: number; keyPrefix?: string }) {
  const { windowMs, max, keyPrefix = 'rl' } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    // One bucket per client per prefix (not per path) so a normal dashboard
    // load (metrics + users + activity in parallel) doesn't exhaust limits.
    const bucketKey = `${keyPrefix}:${getClientKey(req)}`;
    const existing = buckets.get(bucketKey);

    if (!existing || existing.resetAt <= now) {
      buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(max - 1));
      next();
      return;
    }

    if (existing.count >= max) {
      const retryAfterSec = Math.ceil((existing.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', '0');
      sendError(res, 'Too many requests. Please try again later.', 429);
      return;
    }

    existing.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(max - existing.count));
    next();
  };
}

/** Stricter limits for authentication endpoints. */
export const adminLoginRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyPrefix: 'admin-login' });

/** General admin API rate limit — generous but prevents abuse. */
export const adminApiRateLimit = rateLimit({ windowMs: 60 * 1000, max: 300, keyPrefix: 'admin-api' });
