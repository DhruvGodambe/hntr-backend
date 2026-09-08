import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.VOUCHER_CODE_PEPPER = 'test-pepper-value';
  // 32 bytes hex
  process.env.VOUCHER_CODE_ENC_KEY =
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  process.env.APP_BASE_URL = 'https://app.example.com';
});

// Import after env is set so config/env picks up the test values.
async function load() {
  return import('../utils/voucherCode');
}

describe('voucherCode', () => {
  it('generates well-formed 60-bit codes', async () => {
    const code = await load();
    for (let i = 0; i < 200; i += 1) {
      const c = code.generateCode();
      expect(c).toMatch(/^HNTR-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
      expect(code.isWellFormed(code.normalize(c))).toBe(true);
    }
  });

  it('generates distinct codes (no obvious RNG reuse)', async () => {
    const code = await load();
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(code.generateCode());
    expect(seen.size).toBe(500);
  });

  it('normalize is lenient and idempotent', async () => {
    const code = await load();
    const canonical = code.generateCode();
    const messy = ` ${canonical.toLowerCase().replace(/-/g, ' - ')} `;
    expect(code.normalize(messy)).toBe(canonical);
    expect(code.normalize(canonical.replace('HNTR-', ''))).toBe(canonical);
    expect(code.normalize(code.normalize(canonical))).toBe(canonical);
  });

  it('hmac is stable for a code and changes with the code', async () => {
    const code = await load();
    const a = code.normalize(code.generateCode());
    const b = code.normalize(code.generateCode());
    expect(code.hmac(a)).toBe(code.hmac(a));
    expect(code.hmac(a)).not.toBe(code.hmac(b));
    expect(code.hmac(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('encrypt/decrypt round-trips and ciphertext is non-deterministic', async () => {
    const code = await load();
    const plain = code.generateCode();
    const c1 = code.encrypt(plain);
    const c2 = code.encrypt(plain);
    expect(c1).not.toBe(c2); // random IV
    expect(code.decrypt(c1)).toBe(plain);
    expect(code.decrypt(c2)).toBe(plain);
  });

  it('rejects a tampered ciphertext (GCM auth tag)', async () => {
    const code = await load();
    const packed = code.encrypt(code.generateCode());
    const [iv, tag, ct] = packed.split(':');
    const flipped = ct.slice(0, -2) + (ct.slice(-2) === 'AA' ? 'BB' : 'AA');
    expect(() => code.decrypt([iv, tag, flipped].join(':'))).toThrow();
  });

  it('builds a redeem URL from APP_BASE_URL', async () => {
    const code = await load();
    const c = code.generateCode();
    expect(code.redeemUrl(c)).toBe(`https://app.example.com/redeem?code=${encodeURIComponent(c)}`);
  });

  it('last4 returns the final group', async () => {
    const code = await load();
    const c = code.normalize(code.generateCode());
    expect(code.last4(c)).toBe(c.slice(-4));
  });
});
