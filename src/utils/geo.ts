import { Request } from 'express';

/** Cloudflare sentinel values that don't map to a real country. */
const UNRESOLVED_COUNTRY_CODES = new Set(['XX', 'T1', 'EU']);

/**
 * Best-effort visitor country from Cloudflare's `cf-ipcountry` header (present on
 * every request once the site is proxied through Cloudflare — same setup already
 * relied on for Turnstile). Returns undefined off-Cloudflare (e.g. local dev) or
 * for Cloudflare's own "unresolved" sentinels, rather than guessing.
 */
export function countryFromRequest(req: Request): string | undefined {
  const header = req.headers['cf-ipcountry'];
  const raw = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : '';
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || UNRESOLVED_COUNTRY_CODES.has(code)) return undefined;
  return code;
}
