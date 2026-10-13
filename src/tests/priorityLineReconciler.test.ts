import { describe, it, expect, vi, beforeEach } from 'vitest';

const WALLET = '0x3333333333333333333333333333333333333333';
const OLD_WALLET = '0x4444444444444444444444444444444444444444';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const MEMBER = '0x1111111111111111111111111111111111111111';

const state = vi.hoisted(() => ({
  settings: null as any,
  recorded: new Set<string>(),
  stamps: {} as Record<string, Date | undefined>,
  log: [] as string[],
  cursor: null as number | null,
  transfers: [] as any[],
  fetchCalls: [] as any[],
  confirmCalls: [] as any[],
  confirmImpl: null as null | ((wallet: string, hash: string, token: string) => Promise<any>),
  chainId: 1n,
}));

vi.mock('../config/env', () => ({
  ENV: { ETHERSCAN_API_KEY: 'k', ETHERSCAN_CHAIN_ID: 1, NODE_ENV: 'development' },
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../services/contract.service', () => ({
  hntrContract: { usdt: async () => USDT, usdc: async () => USDC },
  provider: { getNetwork: async () => ({ chainId: state.chainId }) },
}));

vi.mock('../models/AdminSettings', () => ({
  __esModule: true,
  default: { findOne: () => ({ lean: async () => state.settings }) },
}));

vi.mock('../models/PriorityLineDeposit', () => ({
  __esModule: true,
  default: {
    find: (q: any) => ({
      select: () => ({
        lean: async () =>
          q.txHash.$in.filter((h: string) => state.recorded.has(h)).map((h: string) => ({ txHash: h, txTimestamp: state.stamps[h] })),
      }),
    }),
    updateMany: async (q: any, u: any) => {
      state.log.push(`stamp ${q.txHash}`);
      state.stamps[q.txHash] = u.$set.txTimestamp;
    },
  },
}));

vi.mock('../models/SyncState', () => ({
  __esModule: true,
  default: {
    findOne: () => ({ lean: async () => (state.cursor === null ? null : { lastProcessedBlock: state.cursor }) }),
    findOneAndUpdate: async (_q: any, u: any) => {
      state.cursor = u.lastProcessedBlock;
    },
  },
}));

vi.mock('../services/etherscan.service', () => ({
  getTokenTransfersViaEtherscan: async (p: any) => {
    state.fetchCalls.push(p);
    return state.transfers.filter(
      (t) => t.contractAddress === p.contractAddress && (t.to === p.address || t.from === p.address) && t.blockNumber >= p.fromBlock,
    );
  },
}));

vi.mock('../services/priorityLine.service', async () => {
  class PriorityLineError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    PriorityLineError,
    PriorityLineService: {
      confirmDeposit: async (wallet: string, hash: string, token: string) => {
        state.confirmCalls.push({ wallet, hash, token });
        state.log.push(`confirm ${hash}`);
        if (state.confirmImpl) return state.confirmImpl(wallet, hash, token);
        state.recorded.add(hash);
        return { deposits: [] };
      },
    },
  };
});

import { reconcilePriorityLineDeposits } from '../services/priorityLineReconciler.service';
import { PriorityLineError } from '../services/priorityLine.service';

function transfer(hash: string, block: number, extra: Partial<any> = {}) {
  return { hash, blockNumber: block, timeStamp: 0, from: MEMBER, to: WALLET, contractAddress: USDC, value: '100000000', confirmations: 10, ...extra };
}

beforeEach(() => {
  state.settings = { priorityLineDepositWallet: WALLET };
  state.recorded = new Set();
  state.stamps = {};
  state.log = [];
  state.cursor = null;
  state.transfers = [];
  state.fetchCalls = [];
  state.confirmCalls = [];
  state.confirmImpl = null;
});

describe('reconcilePriorityLineDeposits', () => {
  it('credits only transfers missing from the DB, with the right token, and advances the cursor', async () => {
    state.recorded.add('0xa');
    state.transfers = [
      transfer('0xa', 100),
      transfer('0xb', 120),
      transfer('0xc', 130, { contractAddress: USDT }),
      transfer('0xout', 140, { from: WALLET, to: MEMBER }), // payout leaving the deposit wallet
    ];
    const r = await reconcilePriorityLineDeposits();
    expect(state.confirmCalls).toEqual([
      { wallet: MEMBER, hash: '0xb', token: 'USDC' },
      { wallet: MEMBER, hash: '0xc', token: 'USDT' },
    ]);
    expect(r!.credited.map((c) => c.txHash)).toEqual(['0xb', '0xc']);
    expect(state.cursor).toBe(130);
  });

  it('credits oldest first across tokens and stamps chain time on recorded rows before crediting', async () => {
    state.recorded.add('0xknown');
    state.transfers = [
      transfer('0xlateUsdc', 300),
      transfer('0xknown', 250, { timeStamp: 1234 }),
      transfer('0xearlyUsdt', 200, { contractAddress: USDT }),
    ];
    await reconcilePriorityLineDeposits();
    expect(state.log).toEqual(['stamp 0xknown', 'confirm 0xearlyUsdt', 'confirm 0xlateUsdc']);
    expect(state.stamps['0xknown']).toEqual(new Date(1234_000));
  });

  it('does not restamp rows that already have a chain time', async () => {
    state.recorded.add('0xknown');
    state.stamps['0xknown'] = new Date(1);
    state.transfers = [transfer('0xknown', 250)];
    await reconcilePriorityLineDeposits();
    expect(state.log).toEqual([]);
  });

  it('rescans an overlap window behind the cursor', async () => {
    state.cursor = 10_000;
    await reconcilePriorityLineDeposits();
    expect(state.fetchCalls.every((c) => c.fromBlock === 9_700)).toBe(true);
  });

  it('also watches previous deposit wallets', async () => {
    state.settings = { priorityLineDepositWallet: WALLET, priorityLineWalletHistory: [OLD_WALLET] };
    state.transfers = [transfer('0xold', 50, { to: OLD_WALLET })];
    await reconcilePriorityLineDeposits();
    expect(state.confirmCalls.map((c) => c.hash)).toEqual(['0xold']);
  });

  it('skips permanent failures (dust) but holds the cursor before transient ones', async () => {
    state.transfers = [transfer('0xdust', 100, { value: '740' }), transfer('0xflaky', 200), transfer('0xlater', 300)];
    state.confirmImpl = async (_w, hash) => {
      if (hash === '0xdust') throw new PriorityLineError('BELOW_MINIMUM', 'min');
      if (hash === '0xflaky') throw new Error('rpc timeout');
      state.recorded.add(hash);
      return { deposits: [] };
    };
    const r = await reconcilePriorityLineDeposits();
    expect(r!.skipped.map((s) => s.reason)).toEqual(['BELOW_MINIMUM']);
    expect(r!.credited.map((c) => c.txHash)).toEqual(['0xlater']);
    expect(state.cursor).toBe(199);

    // Next run retries the held transfer and only then moves past it.
    state.confirmImpl = null;
    state.confirmCalls = [];
    await reconcilePriorityLineDeposits();
    expect(state.confirmCalls.map((c) => c.hash)).toContain('0xflaky');
    expect(state.cursor).toBe(300);
  });

  it('waits for confirmations before crediting', async () => {
    state.transfers = [transfer('0xfresh', 500, { confirmations: 1 })];
    await reconcilePriorityLineDeposits();
    expect(state.confirmCalls).toEqual([]);
    expect(state.cursor).toBeNull();
  });

  it('refuses to run when the RPC is on a different chain than Etherscan', async () => {
    vi.resetModules();
    state.chainId = 11155111n;
    const { reconcilePriorityLineDeposits: fresh } = await import('../services/priorityLineReconciler.service');
    state.transfers = [transfer('0xb', 120)];
    expect(await fresh()).toBeNull();
    expect(state.confirmCalls).toEqual([]);
    state.chainId = 1n;
  });
});
