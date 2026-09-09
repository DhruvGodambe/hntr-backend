import jwt from 'jsonwebtoken';
import { ENV } from '../config/env';
import { AdminAccountService } from './adminAccount.service';
import { normalizeAdminUsername } from '../utils/adminCredentials';

export interface AdminTokenPayload {
  role: 'admin';
  sub: string;
  username?: string;
}

export interface AdminAuthResult {
  token: string;
  expiresAt: number;
  role: 'admin';
  username: string;
  adminId: string;
}

export class AdminAuthService {
  /** Legacy env password check — kept for backward compatibility. */
  static verifyPassword(password: string): boolean {
    if (!ENV.ADMIN_PASSWORD) return false;
    return password === ENV.ADMIN_PASSWORD;
  }

  static issueToken(adminId: string, username: string): string {
    const payload: AdminTokenPayload = {
      role: 'admin',
      sub: adminId,
      username,
    };
    return jwt.sign(payload, ENV.JWT_SECRET, { expiresIn: ENV.ADMIN_TOKEN_TTL_SECONDS });
  }

  static issueLegacyToken(): string {
    const payload: AdminTokenPayload = { role: 'admin', sub: 'admin-panel', username: 'admin' };
    return jwt.sign(payload, ENV.JWT_SECRET, { expiresIn: ENV.ADMIN_TOKEN_TTL_SECONDS });
  }

  static verifyToken(token: string): AdminTokenPayload {
    const payload = jwt.verify(token, ENV.JWT_SECRET) as AdminTokenPayload & { role?: string };
    if (payload.role !== 'admin' || !payload.sub) {
      throw new Error('Invalid admin token');
    }
    return payload;
  }

  static isConfigured(): boolean {
    return Boolean(ENV.ADMIN_PASSWORD) || ENV.ADMIN_DB_AUTH !== 'false';
  }

  static async authenticateWithDatabase(username: string, password: string): Promise<AdminAuthResult | null> {
    const normalized = normalizeAdminUsername(username);
    const account = await AdminAccountService.findByUsername(normalized);

    if (!account || !account.isActive) {
      return null;
    }

    if (AdminAccountService.isLocked(account)) {
      throw new Error('ACCOUNT_LOCKED');
    }

    const valid = await AdminAccountService.verifyPassword(account, password);
    if (!valid) {
      await AdminAccountService.recordFailedLogin(account);
      return null;
    }

    await AdminAccountService.recordSuccessfulLogin(account);

    const adminId = String(account._id);
    const token = this.issueToken(adminId, account.username);
    const expiresAt = Date.now() + ENV.ADMIN_TOKEN_TTL_SECONDS * 1000;

    return {
      token,
      expiresAt,
      role: 'admin',
      username: account.username,
      adminId,
    };
  }

  static authenticateWithEnvPassword(password: string): AdminAuthResult | null {
    if (!this.verifyPassword(password)) return null;

    const token = this.issueLegacyToken();
    const expiresAt = Date.now() + ENV.ADMIN_TOKEN_TTL_SECONDS * 1000;

    return {
      token,
      expiresAt,
      role: 'admin',
      username: 'admin',
      adminId: 'admin-panel',
    };
  }
}
