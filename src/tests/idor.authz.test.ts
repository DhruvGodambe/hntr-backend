import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Express, Request, Response } from 'express';

const ids = vi.hoisted(() => ({
  walletA: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  walletB: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  userA: 'alice',
  userB: 'bob',
}));

function stubOk(_req: Request, res: Response): void {
  res.status(200).json({ success: true, data: { stubbed: true } });
}

vi.mock('../services/user.service', () => ({
  UserError: class UserError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode = 400) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
    }
  },
  UserService: {
    getUserByUsername: async (username: string) => {
      if (username === ids.userA) {
        return { username: ids.userA, walletAddress: ids.walletA };
      }
      if (username === ids.userB) {
        return { username: ids.userB, walletAddress: ids.walletB };
      }
      return null;
    },
  },
}));

vi.mock('../controllers/user.controller', () => ({
  UserController: {
    validateSponsor: stubOk,
    register: (_req: Request, res: Response) => {
      res.status(201).json({ success: true, data: { stubbed: true } });
    },
    getProfile: stubOk,
    getProfileByWallet: stubOk,
  },
}));

vi.mock('../controllers/network.controller', () => ({
  NetworkController: {
    getUplines: stubOk,
    getDownline: stubOk,
    getNetworkTree: stubOk,
    claimCommissions: stubOk,
    failPendingRelay: stubOk,
    submitPendingRelay: stubOk,
    getTransactions: stubOk,
    getRewardsSummary: stubOk,
    getLeadershipPayouts: stubOk,
    getLeadershipStatus: stubOk,
    getAchievementStatus: stubOk,
    getNotifications: stubOk,
    markNotificationsRead: stubOk,
    getPointsSummary: stubOk,
    recalculatePoints: stubOk,
  },
}));

import { createApp } from '../app';
import { ENV } from '../config/env';

/** Mixed-case path wallet — owner check must be checksum-insensitive. */
function mixedCaseWallet(address: string): string {
  return (
    address.slice(0, 2) +
    address
      .slice(2)
      .split('')
      .map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()))
      .join('')
  );
}

type LockedRoute = {
  name: string;
  method: 'get' | 'post';
  path: (identity: string) => string;
  kind: 'wallet' | 'username';
};

const lockedRoutes: LockedRoute[] = [
  { name: 'GET /api/users/wallet/:walletAddress', method: 'get', kind: 'wallet', path: (id) => `/api/users/wallet/${id}` },
  { name: 'GET /api/users/:username', method: 'get', kind: 'username', path: (id) => `/api/users/${id}` },
  { name: 'GET /api/network/:walletAddress/points', method: 'get', kind: 'wallet', path: (id) => `/api/network/${id}/points` },
  { name: 'GET /api/network/transactions/:walletAddress', method: 'get', kind: 'wallet', path: (id) => `/api/network/transactions/${id}` },
  { name: 'GET /api/network/:username/tree', method: 'get', kind: 'username', path: (id) => `/api/network/${id}/tree` },
  { name: 'GET /api/network/:username/uplines', method: 'get', kind: 'username', path: (id) => `/api/network/${id}/uplines` },
  { name: 'GET /api/network/:username/downline', method: 'get', kind: 'username', path: (id) => `/api/network/${id}/downline` },
  { name: 'GET /api/network/:walletAddress/leadership-status', method: 'get', kind: 'wallet', path: (id) => `/api/network/${id}/leadership-status` },
  { name: 'GET /api/network/:walletAddress/achievement-status', method: 'get', kind: 'wallet', path: (id) => `/api/network/${id}/achievement-status` },
  { name: 'GET /api/network/:walletAddress/notifications', method: 'get', kind: 'wallet', path: (id) => `/api/network/${id}/notifications` },
  { name: 'GET /api/network/:walletAddress/rewards-summary', method: 'get', kind: 'wallet', path: (id) => `/api/network/${id}/rewards-summary` },
  { name: 'GET /api/network/:walletAddress/leadership-payouts', method: 'get', kind: 'wallet', path: (id) => `/api/network/${id}/leadership-payouts` },
  { name: 'POST /api/network/:walletAddress/notifications/read', method: 'post', kind: 'wallet', path: (id) => `/api/network/${id}/notifications/read` },
  { name: 'POST /api/network/:walletAddress/points/recalculate', method: 'post', kind: 'wallet', path: (id) => `/api/network/${id}/points/recalculate` },
];

describe('VAPT IDOR / BOLA — owner-only user and network APIs', () => {
  let app: Express;
  let tokenA: string;

  beforeAll(() => {
    app = createApp();
    tokenA = jwt.sign({ walletAddress: ids.walletA }, ENV.JWT_SECRET, { expiresIn: '1h' });
  });

  function authHeader(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function call(method: 'get' | 'post', path: string) {
    const req = method === 'post' ? request(app).post(path).send({}) : request(app).get(path);
    return req;
  }

  for (const route of lockedRoutes) {
    describe(route.name, () => {
      const selfId = route.kind === 'wallet' ? mixedCaseWallet(ids.walletA) : ids.userA;
      const otherId = route.kind === 'wallet' ? ids.walletB : ids.userB;

      it('returns 401 without Authorization', async () => {
        const res = await call(route.method, route.path(selfId));
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      });

      it('returns 403 when the session wallet does not own the path identity', async () => {
        const res = await call(route.method, route.path(otherId)).set(authHeader(tokenA));
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it('returns 200 when the session wallet owns the path identity', async () => {
        const res = await call(route.method, route.path(selfId)).set(authHeader(tokenA));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });
    });
  }

  it('GET /api/users/sponsor/:username/validate stays public (not 401 from owner middleware)', async () => {
    const res = await request(app).get(`/api/users/sponsor/${ids.userA}/validate`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it('POST /api/users/register stays public (not 401 from owner middleware)', async () => {
    const res = await request(app).post('/api/users/register').send({});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(201);
  });

  it('GET /api/auth/nonce stays public', async () => {
    const res = await request(app).get(`/api/auth/nonce`).query({ walletAddress: ids.walletA });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
