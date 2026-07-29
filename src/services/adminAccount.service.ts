import bcrypt from 'bcrypt';
import AdminAccount, { IAdminAccount } from '../models/AdminAccount';
import { normalizeAdminUsername, validateAdminPassword, validateAdminUsername } from '../utils/adminCredentials';

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

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
    return AdminAccount.findOne({ username: normalized }).select('+passwordHash');
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
}
