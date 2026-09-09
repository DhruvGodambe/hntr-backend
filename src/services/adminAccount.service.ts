import bcrypt from 'bcrypt';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import qrcode from 'qrcode';
import AdminAccount, { IAdminAccount } from '../models/AdminAccount';
import { normalizeAdminUsername, validateAdminPassword, validateAdminUsername } from '../utils/adminCredentials';

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const TOTP_ISSUER = 'HNTR Admin';

export class AdminAccountError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 400, code = 'ADMIN_ACCOUNT_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class AdminAccountService {
  static async countActiveAccounts(): Promise<number> {
    return AdminAccount.countDocuments({ isActive: true });
  }

  static async countAllAccounts(): Promise<number> {
    return AdminAccount.countDocuments({});
  }

  static async findByUsername(username: string): Promise<IAdminAccount | null> {
    const normalized = normalizeAdminUsername(username);
    return AdminAccount.findOne({ username: normalized }).select('+passwordHash +totpSecret');
  }

  static async createAccount(username: string, password: string): Promise<{ id: string; username: string }> {
    const usernameError = validateAdminUsername(username);
    if (usernameError) throw new AdminAccountError(usernameError, 400, 'INVALID_USERNAME');

    const passwordError = validateAdminPassword(password);
    if (passwordError) throw new AdminAccountError(passwordError, 400, 'INVALID_PASSWORD');

    const normalized = normalizeAdminUsername(username);
    const existing = await AdminAccount.findOne({ username: normalized });
    if (existing) {
      throw new AdminAccountError('Username is already taken.', 409, 'USERNAME_TAKEN');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const account = await AdminAccount.create({
      username: normalized,
      passwordHash,
      isActive: true,
    });

    return { id: String(account._id), username: account.username };
  }

  static isLocked(account: IAdminAccount): boolean {
    return Boolean(account.lockedUntil && account.lockedUntil.getTime() > Date.now());
  }

  static async verifyPassword(account: IAdminAccount, password: string): Promise<boolean> {
    if (!account.passwordHash) return false;
    return bcrypt.compare(password, account.passwordHash);
  }

  static async recordFailedLogin(account: IAdminAccount): Promise<void> {
    const attempts = (account.failedLoginAttempts || 0) + 1;
    const update: Partial<IAdminAccount> = { failedLoginAttempts: attempts };

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      update.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
      update.failedLoginAttempts = 0;
    }

    await AdminAccount.updateOne({ _id: account._id }, update);
  }

  static async recordSuccessfulLogin(account: IAdminAccount): Promise<void> {
    await AdminAccount.updateOne(
      { _id: account._id },
      {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    );
  }

  static async getPublicProfile(accountId: string): Promise<{ id: string; username: string; lastLoginAt?: Date | null } | null> {
    const account = await AdminAccount.findById(accountId).select('username lastLoginAt');
    if (!account || !account.isActive) return null;
    return {
      id: String(account._id),
      username: account.username,
      lastLoginAt: account.lastLoginAt,
    };
  }

  // --- Two-factor authentication (TOTP) ---

  static async findByIdWithTotp(accountId: string): Promise<IAdminAccount | null> {
    return AdminAccount.findById(accountId).select('+totpSecret +totpPendingSecret');
  }

  static async verifyTotpCode(secret: string, code: string): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false;
    try {
      const result = await verifyTotp({ secret, token: code });
      return result.valid;
    } catch {
      return false;
    }
  }

  /** Starts (or restarts) 2FA setup: generates a new pending secret + QR code, not yet active. */
  static async generateTotpSetup(accountId: string): Promise<{ secret: string; qrCodeDataUrl: string }> {
    const account = await AdminAccount.findById(accountId);
    if (!account || !account.isActive) {
      throw new AdminAccountError('Admin account not found.', 404, 'ACCOUNT_NOT_FOUND');
    }

    const secret = generateSecret();
    const otpauthUrl = generateURI({ issuer: TOTP_ISSUER, label: account.username, secret });
    const qrCodeDataUrl = await qrcode.toDataURL(otpauthUrl);

    await AdminAccount.updateOne({ _id: account._id }, { totpPendingSecret: secret });

    return { secret, qrCodeDataUrl };
  }

  /** Confirms setup by checking a code against the pending secret, then activates 2FA. */
  static async confirmTotpSetup(accountId: string, code: string): Promise<void> {
    const account = await this.findByIdWithTotp(accountId);
    if (!account || !account.isActive) {
      throw new AdminAccountError('Admin account not found.', 404, 'ACCOUNT_NOT_FOUND');
    }
    if (!account.totpPendingSecret) {
      throw new AdminAccountError('No pending 2FA setup. Start setup again.', 400, 'NO_PENDING_2FA');
    }
    if (!(await this.verifyTotpCode(account.totpPendingSecret, code))) {
      throw new AdminAccountError('Invalid authentication code.', 400, 'INVALID_TOTP_CODE');
    }

    await AdminAccount.updateOne(
      { _id: account._id },
      { totpEnabled: true, totpSecret: account.totpPendingSecret, totpPendingSecret: null },
    );
  }

  /** Disables 2FA — requires a currently-valid code so a stolen session token alone can't turn it off. */
  static async disableTotp(accountId: string, code: string): Promise<void> {
    const account = await this.findByIdWithTotp(accountId);
    if (!account || !account.isActive) {
      throw new AdminAccountError('Admin account not found.', 404, 'ACCOUNT_NOT_FOUND');
    }
    if (!account.totpEnabled || !account.totpSecret) {
      throw new AdminAccountError('Two-factor authentication is not enabled.', 400, 'TOTP_NOT_ENABLED');
    }
    if (!(await this.verifyTotpCode(account.totpSecret, code))) {
      throw new AdminAccountError('Invalid authentication code.', 400, 'INVALID_TOTP_CODE');
    }

    await AdminAccount.updateOne(
      { _id: account._id },
      { totpEnabled: false, totpSecret: null, totpPendingSecret: null },
    );
  }

  static async getTotpStatus(accountId: string): Promise<{ enabled: boolean }> {
    const account = await AdminAccount.findById(accountId).select('totpEnabled');
    if (!account) {
      throw new AdminAccountError('Admin account not found.', 404, 'ACCOUNT_NOT_FOUND');
    }
    return { enabled: account.totpEnabled };
  }
}
