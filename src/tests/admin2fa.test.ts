import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSecret, generate as generateTotp } from 'otplib';

/**
 * TOTP 2FA for admin accounts. The Mongo layer is mocked — these tests cover the
 * pieces that are easy to get wrong: code verification and the login branching
 * that must NOT penalize a correct password that is merely missing its 2FA code.
 */

const updateOne = vi.fn();
const findById = vi.fn();
const findOne = vi.fn();

vi.mock('../models/AdminAccount', () => ({
  __esModule: true,
  default: {
    updateOne: (...args: unknown[]) => updateOne(...args),
    findById: (...args: unknown[]) => findById(...args),
    findOne: (...args: unknown[]) => findOne(...args),
    countDocuments: vi.fn(),
  },
}));

// A mongoose-ish query stub: `.select()` chains and the object itself is awaited.
function query<T>(doc: T) {
  return { select: () => query(doc), then: (r: (v: T) => unknown) => r(doc) };
}

import { AdminAccountService } from '../services/adminAccount.service';
import { AdminAuthService } from '../services/adminAuth.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AdminAccountService.verifyTotpCode', () => {
  it('accepts a fresh code for the secret', async () => {
    const secret = generateSecret();
    const token = await generateTotp({ secret });
    expect(await AdminAccountService.verifyTotpCode(secret, token)).toBe(true);
  });

  it('rejects a wrong code and non-6-digit input', async () => {
    const secret = generateSecret();
    expect(await AdminAccountService.verifyTotpCode(secret, '000000')).toBe(false);
    expect(await AdminAccountService.verifyTotpCode(secret, '12345')).toBe(false);
    expect(await AdminAccountService.verifyTotpCode(secret, 'abcdef')).toBe(false);
    expect(await AdminAccountService.verifyTotpCode(secret, '')).toBe(false);
  });
});

describe('AdminAuthService.authenticateWithDatabase — 2FA branch', () => {
  const password = 'correct-horse-1';
  let secret: string;

  beforeEach(() => {
    secret = generateSecret();
    vi.spyOn(AdminAccountService, 'findByUsername').mockResolvedValue({
      _id: 'acc1',
      username: 'root',
      isActive: true,
      totpEnabled: true,
      totpSecret: secret,
      passwordHash: 'x',
    } as never);
    vi.spyOn(AdminAccountService, 'isLocked').mockReturnValue(false);
    vi.spyOn(AdminAccountService, 'verifyPassword').mockResolvedValue(true);
    vi.spyOn(AdminAccountService, 'recordFailedLogin').mockResolvedValue(undefined);
    vi.spyOn(AdminAccountService, 'recordSuccessfulLogin').mockResolvedValue(undefined);
  });

  it('returns a TOTP challenge (no failed-login penalty) when the code is missing', async () => {
    const res = await AdminAuthService.authenticateWithDatabase('root', password);
    expect(res).toEqual({ requiresTotp: true });
    expect(AdminAccountService.recordFailedLogin).not.toHaveBeenCalled();
    expect(AdminAccountService.recordSuccessfulLogin).not.toHaveBeenCalled();
  });

  it('rejects a wrong code AND records a failed attempt', async () => {
    const res = await AdminAuthService.authenticateWithDatabase('root', password, '000000');
    expect(res).toBeNull();
    expect(AdminAccountService.recordFailedLogin).toHaveBeenCalledOnce();
  });

  it('issues a token when the code is valid', async () => {
    const token = await generateTotp({ secret });
    const res = await AdminAuthService.authenticateWithDatabase('root', password, token);
    expect(res).not.toBeNull();
    expect(res).toHaveProperty('token');
    expect(AdminAccountService.recordSuccessfulLogin).toHaveBeenCalledOnce();
  });

  it('still rejects a bad password before any 2FA logic', async () => {
    vi.spyOn(AdminAccountService, 'verifyPassword').mockResolvedValue(false);
    const res = await AdminAuthService.authenticateWithDatabase('root', 'wrong');
    expect(res).toBeNull();
    expect(AdminAccountService.recordFailedLogin).toHaveBeenCalledOnce();
  });
});

describe('AdminAccountService TOTP setup / confirm / disable', () => {
  it('generateTotpSetup stores a pending secret and returns a QR data URL', async () => {
    findById.mockReturnValue(query({ _id: 'a', username: 'root', isActive: true, totpEnabled: false }));
    const out = await AdminAccountService.generateTotpSetup('a');
    expect(out.secret).toMatch(/^[A-Z2-7]+$/);
    expect(out.qrCodeDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(updateOne).toHaveBeenCalledWith({ _id: 'a' }, { totpPendingSecret: out.secret });
  });

  it('confirmTotpSetup rejects a wrong code and activates on a right one', async () => {
    const secret = generateSecret();
    findById.mockReturnValue(
      query({ _id: 'a', username: 'root', isActive: true, totpEnabled: false, totpPendingSecret: secret }),
    );

    await expect(AdminAccountService.confirmTotpSetup('a', '000000')).rejects.toMatchObject({
      code: 'INVALID_TOTP_CODE',
    });

    const token = await generateTotp({ secret });
    await AdminAccountService.confirmTotpSetup('a', token);
    expect(updateOne).toHaveBeenLastCalledWith(
      { _id: 'a' },
      { totpEnabled: true, totpSecret: secret, totpPendingSecret: null },
    );
  });

  it('disableTotp requires a valid current code', async () => {
    const secret = generateSecret();
    findById.mockReturnValue(
      query({ _id: 'a', username: 'root', isActive: true, totpEnabled: true, totpSecret: secret }),
    );

    await expect(AdminAccountService.disableTotp('a', '000000')).rejects.toMatchObject({
      code: 'INVALID_TOTP_CODE',
    });

    const token = await generateTotp({ secret });
    await AdminAccountService.disableTotp('a', token);
    expect(updateOne).toHaveBeenLastCalledWith(
      { _id: 'a' },
      { totpEnabled: false, totpSecret: null, totpPendingSecret: null },
    );
  });
});
