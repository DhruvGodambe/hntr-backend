import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';

const USER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const DEPOSIT_WALLET = '0x3333333333333333333333333333333333333333';
const OLD_WALLET = '0x4444444444444444444444444444444444444444';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const state = vi.hoisted(() => ({
  deposits: [] as any[],
  tiers: {} as Record<string, string>,
  settings: null as any,
  counter: 0,
  receipt: null as any,
  seq: 0,
  notifications: [] as any[],
  lastFind: null as null | { q: any; sort: any },
}));

function matches(row: any, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') return (v as any[]).some((f) => matches(row, f));
    const actual = k === '_id' ? String(row._id) : row[k];
    if (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof RegExp)) {
      if ('$in' in v) return v.$in.includes(actual);
      if ('$exists' in v) return (actual !== undefined) === v.$exists;
      if ('$type' in v) return true;
    }
    return actual === v;
  });
}

function wrap(row: any) {
  return Object.assign(row, { id: String(row._id), toObject: () => ({ ...row }) });
}

vi.mock('../models/PriorityLineDeposit', () => ({
  __esModule: true,
  default: {
    find: (q: any = {}) => {
      let rows = state.deposits.filter((r) => matches(r, q));
      const chain: any = {
        select: () => chain,
        sort: (spec: any) => {
          state.lastFind = { q, sort: spec };
          return chain;
        },
        skip: () => chain,
        limit: () => chain,
        lean: async () => rows.map((r) => ({ ...r })),
      };
      return chain;
    },
    findOne: async (q: any) => state.deposits.find((r) => matches(r, q)) ?? null,
    exists: async (q: any) => (state.deposits.some((r) => matches(r, q)) ? { _id: 1 } : null),
    countDocuments: async (q: any = {}) => state.deposits.filter((r) => matches(r, q)).length,
    create: async (data: any) => {
      if (state.deposits.some((r) => r.txHash === data.txHash && r.logIndex === data.logIndex)) {
        throw Object.assign(new Error('dup'), { code: 11000 });
      }
      const row = wrap({ ...data, _id: (++state.seq).toString(16).padStart(24, '0'), createdAt: new Date(1_700_000_000_000 + state.seq) });
      state.deposits.push(row);
      return row;
    },
    findOneAndUpdate: async (q: any, update: any) => {
      const row = state.deposits.find((r) => matches(r, q));
      if (!row) return null;
      Object.assign(row, update.$set ?? {});
      for (const k of Object.keys(update.$unset ?? {})) delete row[k];
      return row;
    },
  },
}));

vi.mock('../models/Counter', () => ({
  __esModule: true,
  default: { findOneAndUpdate: async () => ({ seq: ++state.counter }) },
}));

vi.mock('../models/User', () => ({
  __esModule: true,
  default: {
    findOne: (q: any) => ({
      select: () => ({ lean: async () => (state.tiers[q.walletAddress] ? { tier: state.tiers[q.walletAddress] } : null) }),
    }),
    find: () => ({ select: () => ({ limit: () => ({ lean: async () => [] }), lean: async () => [] }) }),
  },
}));

vi.mock('../models/AdminSettings', () => ({
  __esModule: true,
  default: {
    findOne: () => ({ lean: async () => state.settings }),
    findOneAndUpdate: async (_q: any, update: any) => {
      state.settings = { ...(state.settings ?? {}), ...(update.$set ?? {}) };
      if (update.$addToSet?.priorityLineWalletHistory) {
        const h = new Set([...(state.settings.priorityLineWalletHistory ?? []), update.$addToSet.priorityLineWalletHistory]);
        state.settings.priorityLineWalletHistory = [...h];
      }
      return state.settings;
    },
  },
}));

vi.mock('../services/notification.service', () => ({
  NotificationService: {
    createQuiet: async (n: any) => {
      state.notifications.push(n);
      return n;
    },
  },
}));

vi.mock('../services/contract.service', () => ({
  provider: { getTransactionReceipt: async () => state.receipt },
  hntrContract: { usdt: async () => USDT, usdc: async () => USDC },
  getContractAmountDecimals: async () => 6,
}));

import { PriorityLineService } from '../services/priorityLine.service';

const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const TOPIC = iface.getEvent('Transfer')!.topicHash;
const pad = (a: string) => ethers.zeroPadValue(a, 32);
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function transferLog(opts: { token?: string; from?: string; to?: string; usd: number; index?: number }) {
  return {
    address: opts.token ?? USDT,
    topics: [TOPIC, pad(opts.from ?? USER), pad(opts.to ?? DEPOSIT_WALLET)],
    data: ethers.zeroPadValue(ethers.toBeHex(ethers.parseUnits(String(opts.usd), 6)), 32),
    index: opts.index ?? 0,
  };
}

function mine(logs: any[], status = 1) {
  state.receipt = { status, logs };
}

beforeEach(() => {
  state.deposits = [];
  state.tiers = { [USER]: 'Silver', [OTHER]: 'Silver' }; // Silver cap = $1,500
  state.settings = { priorityLineDepositWallet: DEPOSIT_WALLET, priorityLineWalletHistory: [] };
  state.counter = 0;
  state.receipt = null;
  state.seq = 0;
  state.notifications = [];
});

describe('prepareDeposit', () => {
  it('returns the transfer target and raw amount', async () => {
    const r = await PriorityLineService.prepareDeposit(USER, 'usdt', 250.5);
    expect(r).toMatchObject({ depositWallet: DEPOSIT_WALLET, tokenAddress: USDT, decimals: 6, remaining: 1500 });
    expect(r.amountRaw).toBe('250500000');
  });

  it('rejects non-members, unconfigured wallet, bad amounts and over-cap', async () => {
    state.tiers[USER] = 'None';
    await expect(PriorityLineService.prepareDeposit(USER, 'USDT', 10)).rejects.toMatchObject({ code: 'NO_MEMBERSHIP' });
    state.tiers[USER] = 'Silver';
    await expect(PriorityLineService.prepareDeposit(USER, 'DAI', 10)).rejects.toMatchObject({ code: 'UNSUPPORTED_TOKEN' });
    await expect(PriorityLineService.prepareDeposit(USER, 'USDT', 0)).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(PriorityLineService.prepareDeposit(USER, 'USDT', 0.5)).rejects.toMatchObject({ code: 'BELOW_MINIMUM' });
    await expect(PriorityLineService.prepareDeposit(USER, 'USDT', 1500.01)).rejects.toMatchObject({ code: 'OVER_CAP' });
    state.settings = {};
    await expect(PriorityLineService.prepareDeposit(USER, 'USDT', 10)).rejects.toMatchObject({ code: 'DEPOSITS_NOT_CONFIGURED' });
  });
});

describe('confirmDeposit', () => {
  it('credits the amount from the chain log and numbers deposits sequentially', async () => {
    mine([transferLog({ usd: 500 })]);
    const a = await PriorityLineService.confirmDeposit(USER, hash(1), 'USDT');
    expect(a.deposits[0]).toMatchObject({ lineNumber: 1, amountUsd: 500, status: 'ACTIVE' });

    mine([transferLog({ usd: 1000 })]);
    const b = await PriorityLineService.confirmDeposit(USER, hash(2), 'USDT');
    expect(b.deposits[0]).toMatchObject({ lineNumber: 2, amountUsd: 1000, status: 'ACTIVE' });

    const overview = await PriorityLineService.getOverview(USER);
    expect(overview).toMatchObject({ tier: 'Silver', cap: 1500, used: 1500, remaining: 0, firstLineNumber: 1 });
    expect(state.notifications.filter((n) => n.type === 'PRIORITY_LINE_DEPOSIT')).toHaveLength(2);
  });

  it('flags a deposit that lands over the cap as REVIEW without a line number', async () => {
    mine([transferLog({ usd: 1500 })]);
    await PriorityLineService.confirmDeposit(USER, hash(1), 'USDT');
    mine([transferLog({ usd: 10 })]);
    const r = await PriorityLineService.confirmDeposit(USER, hash(2), 'USDT');
    expect(r.deposits[0]).toMatchObject({ status: 'REVIEW', lineNumber: null });
    expect((await PriorityLineService.getOverview(USER)).used).toBe(1500);
  });

  it('is idempotent per transaction and refuses another wallet replaying it', async () => {
    mine([transferLog({ usd: 100 })]);
    await PriorityLineService.confirmDeposit(USER, hash(1), 'USDT');
    const again = await PriorityLineService.confirmDeposit(USER, hash(1), 'USDT');
    expect(again.deposits[0].lineNumber).toBe(1);
    expect(state.deposits).toHaveLength(1);

    mine([transferLog({ usd: 100, from: OTHER })]);
    state.receipt.logs = [transferLog({ usd: 100, from: OTHER })];
    await expect(PriorityLineService.confirmDeposit(OTHER, hash(1), 'USDT')).rejects.toMatchObject({
      code: 'TX_ALREADY_USED',
    });
  });

  it('rejects transfers from the wrong sender, to the wrong recipient, or of the wrong token', async () => {
    mine([transferLog({ usd: 100, from: OTHER })]);
    await expect(PriorityLineService.confirmDeposit(USER, hash(1), 'USDT')).rejects.toMatchObject({ code: 'TRANSFER_NOT_FOUND' });
    mine([transferLog({ usd: 100, to: OTHER })]);
    await expect(PriorityLineService.confirmDeposit(USER, hash(2), 'USDT')).rejects.toMatchObject({ code: 'TRANSFER_NOT_FOUND' });
    mine([transferLog({ usd: 100, token: USDC })]);
    await expect(PriorityLineService.confirmDeposit(USER, hash(3), 'USDT')).rejects.toMatchObject({ code: 'TRANSFER_NOT_FOUND' });
    expect(state.deposits).toHaveLength(0);
  });

  it('handles unmined, failed and malformed transactions', async () => {
    state.receipt = null;
    await expect(PriorityLineService.confirmDeposit(USER, hash(1), 'USDT')).rejects.toMatchObject({ code: 'TX_NOT_MINED', statusCode: 409 });
    mine([transferLog({ usd: 100 })], 0);
    await expect(PriorityLineService.confirmDeposit(USER, hash(1), 'USDT')).rejects.toMatchObject({ code: 'TX_FAILED' });
    await expect(PriorityLineService.confirmDeposit(USER, '0x123', 'USDT')).rejects.toMatchObject({ code: 'INVALID_TX_HASH' });
  });

  it('still accepts a transfer sent to the previous deposit wallet', async () => {
    state.settings = { priorityLineDepositWallet: DEPOSIT_WALLET, priorityLineWalletHistory: [OLD_WALLET] };
    mine([transferLog({ usd: 100, to: OLD_WALLET })]);
    const r = await PriorityLineService.confirmDeposit(USER, hash(1), 'USDT');
    expect(r.deposits[0]).toMatchObject({ status: 'ACTIVE', amountUsd: 100 });
  });
});

describe('withdrawals', () => {
  async function deposit(usd: number, n: number) {
    mine([transferLog({ usd })]);
    return (await PriorityLineService.confirmDeposit(USER, hash(n), 'USDT')).deposits[0];
  }

  it('holds cap room while pending and frees it once the admin pays', async () => {
    const d = await deposit(1000, 1);
    const req = await PriorityLineService.requestWithdrawal(USER, d.id);
    expect(req.status).toBe('WITHDRAWAL_REQUESTED');
    expect((await PriorityLineService.getOverview(USER)).used).toBe(1000);

    await expect(PriorityLineService.requestWithdrawal(USER, d.id)).rejects.toMatchObject({ code: 'NOT_WITHDRAWABLE' });

    const done = await PriorityLineService.completeWithdrawal(d.id, 'admin1', { payoutTxHash: hash(99), note: 'sent' });
    expect(done).toMatchObject({ status: 'WITHDRAWN', processedBy: 'admin1', payoutTxHash: hash(99) });
    const overview = await PriorityLineService.getOverview(USER);
    expect(overview).toMatchObject({ used: 0, remaining: 1500, firstLineNumber: null });
    expect(state.notifications.some((n) => n.type === 'PRIORITY_LINE_WITHDRAWN')).toBe(true);

    await expect(PriorityLineService.completeWithdrawal(d.id, 'admin1', {})).rejects.toMatchObject({ code: 'NOT_PENDING' });
  });

  it("won't let another member request a withdrawal for someone else's deposit", async () => {
    const d = await deposit(100, 1);
    await expect(PriorityLineService.requestWithdrawal(OTHER, d.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(PriorityLineService.requestWithdrawal(USER, 'nope')).rejects.toMatchObject({ code: 'INVALID_DEPOSIT' });
  });

  it('can only complete or reject a pending request; reject puts the deposit back in line', async () => {
    const d = await deposit(100, 1);
    await expect(PriorityLineService.completeWithdrawal(d.id, 'a', {})).rejects.toMatchObject({ code: 'NOT_PENDING' });
    await PriorityLineService.requestWithdrawal(USER, d.id);
    await expect(PriorityLineService.completeWithdrawal(d.id, 'a', { payoutTxHash: 'bad' })).rejects.toMatchObject({ code: 'INVALID_TX_HASH' });
    const r = await PriorityLineService.rejectWithdrawal(d.id, 'a', 'not eligible');
    expect(r.status).toBe('ACTIVE');
    expect((await PriorityLineService.getOverview(USER)).firstLineNumber).toBe(1);
  });
});

describe('admin deposit list ordering', () => {
  it('defaults to newest first', async () => {
    await PriorityLineService.listDeposits({});
    expect(state.lastFind?.sort).toEqual({ createdAt: -1 });
  });

  it('queue view sorts by line number and leaves out deposits with no line number', async () => {
    await PriorityLineService.listDeposits({ sort: 'line' });
    expect(state.lastFind?.sort).toEqual({ lineNumber: 1 });
    expect(state.lastFind?.q.lineNumber).toEqual({ $type: 'number' });
  });
});

describe('admin settings', () => {
  it('validates the address and remembers the previous wallet', async () => {
    await expect(PriorityLineService.setDepositWallet('nope', 'a')).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    await expect(PriorityLineService.setDepositWallet(ethers.ZeroAddress, 'a')).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    const s = await PriorityLineService.setDepositWallet(OLD_WALLET.toUpperCase().replace('0X', '0x'), 'a');
    expect(s.depositWallet).toBe(OLD_WALLET);
    expect(s.walletHistory).toEqual([DEPOSIT_WALLET]);
  });
});
