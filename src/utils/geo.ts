import { Request } from 'express';
import geoip from 'geoip-lite';

/** Cloudflare sentinel values that don't map to a real country. */
const UNRESOLVED_COUNTRY_CODES = new Set(['XX', 'T1', 'EU']);

function isValidCountryCode(code: string): boolean {
  return /^[A-Z]{2}$/.test(code) && !UNRESOLVED_COUNTRY_CODES.has(code);
}

/** Best-effort client IP. Same precedence as turnstile.service's clientIpFrom. */
function clientIpFrom(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.ip || req.socket.remoteAddress || '';
}

/**
 * Best-effort visitor country. This backend runs on Render (not proxied through
 * Cloudflare's network — Turnstile is just the anti-bot widget, unrelated to
 * routing), so `cf-ipcountry` is essentially never set in practice; it's checked
 * first only as a free win if that ever changes. The real source is a local
 * MaxMind GeoLite2 lookup (geoip-lite) against the client IP forwarded by Render's
 * proxy, so it works on the actual hosting setup. Returns undefined for
 * unresolvable/local/private IPs (e.g. local dev) rather than guessing.
 */
export function countryFromRequest(req: Request): string | undefined {
  const header = req.headers['cf-ipcountry'];
  const rawHeader = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : '';
  const headerCode = rawHeader.trim().toUpperCase();
  if (isValidCountryCode(headerCode)) return headerCode;

  const ip = clientIpFrom(req);
  const geo = ip ? geoip.lookup(ip) : null;
  const geoCode = geo?.country?.trim().toUpperCase() ?? '';
  return isValidCountryCode(geoCode) ? geoCode : undefined;
}
