import jwt from 'jsonwebtoken';
import { ENV } from '../config/env';

export interface AdminTokenPayload {
  role: 'admin';
  sub: 'admin-panel';
}

export class AdminAuthService {
  static verifyPassword(password: string): boolean {
    if (!ENV.ADMIN_PASSWORD) return false;
    return password === ENV.ADMIN_PASSWORD;
  }

  static issueToken(): string {
    const payload: AdminTokenPayload = { role: 'admin', sub: 'admin-panel' };
    return jwt.sign(payload, ENV.JWT_SECRET, { expiresIn: ENV.ADMIN_TOKEN_TTL_SECONDS });
  }

  static verifyToken(token: string): AdminTokenPayload {
    const payload = jwt.verify(token, ENV.JWT_SECRET) as AdminTokenPayload & { role?: string };
    if (payload.role !== 'admin' || payload.sub !== 'admin-panel') {
      throw new Error('Invalid admin token');
    }
    return payload;
  }

  static isConfigured(): boolean {
    return Boolean(ENV.ADMIN_PASSWORD);
  }
}
