import crypto from 'crypto';
import { ENV } from '../config/env';

/**
 * Bearer voucher codes.
 *
 * Format: HNTR-XXXX-XXXX-XXXX over a 32-char ambiguity-free alphabet = 60 bits of
 * entropy. Generated server-side with crypto.randomBytes + rejection sampling —
 * never Math.random(), and never on the client (that would let the browser pick
 * the secret).
 *
 * Storage: the plaintext never lands in Mongo. We keep
 *   - codeHash   : HMAC-SHA256(VOUCHER_CODE_PEPPER, normalized) — the unique lookup key
 *   - codeCipher : AES-256-GCM(VOUCHER_CODE_ENC_KEY, plaintext) — issuer-only reveal
 *   - codeLast4  : last 4 chars, for tables
 * so a database dump alone yields no redeemable codes.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 31 chars — no O/0/1/I
const GROUPS = 3;
const GROUP_LEN = 4;

function randomChar(): string {
  // Rejection sampling to avoid modulo bias against a 31-char alphabet.
  const max = 256 - (256 % ALPHABET.length);
  for (;;) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < max) return ALPHABET[byte % ALPHABET.length];
  }
}

export function generateCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g += 1) {
    let chunk = '';
    for (let i = 0; i < GROUP_LEN; i += 1) chunk += randomChar();
    groups.push(chunk);
  }
  return `HNTR-${groups.join('-')}`;
}

/** Uppercase, strip whitespace, tolerate a missing/extra "HNTR-" prefix and stray dashes. */
export function normalize(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/^HNTR-/, '')
    .replace(/-/g, '');
  const body = cleaned.slice(0, GROUPS * GROUP_LEN);
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += GROUP_LEN) groups.push(body.slice(i, i + GROUP_LEN));
  return `HNTR-${groups.join('-')}`;
}

export function isWellFormed(normalized: string): boolean {
  const re = new RegExp(`^HNTR-([${ALPHABET}]{${GROUP_LEN}}-){${GROUPS - 1}}[${ALPHABET}]{${GROUP_LEN}}$`);
  return re.test(normalized);
}

function requirePepper(): string {
  if (!ENV.VOUCHER_CODE_PEPPER) throw new Error('VOUCHER_CODE_PEPPER is not configured');
  return ENV.VOUCHER_CODE_PEPPER;
}

export function hmac(normalizedCode: string): string {
  return crypto.createHmac('sha256', requirePepper()).update(normalizedCode).digest('hex');
}

function encKey(): Buffer {
  const raw = ENV.VOUCHER_CODE_ENC_KEY;
  if (!raw) throw new Error('VOUCHER_CODE_ENC_KEY is not configured');
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('VOUCHER_CODE_ENC_KEY must decode to 32 bytes');
  return buf;
}

/** Returns "iv:tag:ciphertext", all base64. */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(packed: string): string {
  const [ivB64, tagB64, ctB64] = packed.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export function last4(normalizedCode: string): string {
  return normalizedCode.slice(-4);
}

export function redeemUrl(code: string): string {
  return `${ENV.APP_BASE_URL.replace(/\/$/, '')}/redeem?code=${encodeURIComponent(code)}`;
}
