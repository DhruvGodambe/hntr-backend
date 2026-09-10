import VoucherBalance from '../models/VoucherBalance';
import VoucherLedger, { VoucherLedgerReason } from '../models/VoucherLedger';
import { VoucherToken } from '../constants';
import { logger } from '../utils/logger';

/**
 * All VoucherBalance mutations go through here. The invariant that must never
 * break is: you cannot spend more than you hold, even under concurrent requests
 * or a crashed process. That is enforced by a single-document conditional
 * atomic update (`balance: { $gte: amount }`) — race-proof across processes
 * without needing Mongo transactions — plus a unique `entryKey` on the ledger so
 * every mutation is idempotent on retry.
 */

export class VoucherBalanceError extends Error {
  code: string;
  statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isDup(err: any): boolean {
  return err?.code === 11000 || err?.codeName === 'DuplicateKey';
}

/** Ensure a (wallet, token) balance row exists; returns it. */
export async function ensureBalanceRow(walletAddress: string, token: VoucherToken) {
  const wallet = walletAddress.toLowerCase();
  await VoucherBalance.updateOne(
    { walletAddress: wallet, token },
    { $setOnInsert: { walletAddress: wallet, token, balance: 0 } },
    { upsert: true },
  );
  return VoucherBalance.findOne({ walletAddress: wallet, token });
}

async function appendLedger(params: {
  walletAddress: string;
  token: VoucherToken;
  entryKey: string;
  delta: number;
  balanceAfter: number;
  reason: VoucherLedgerReason;
  voucherId?: string;
  adminUsername?: string;
  note?: string;
}): Promise<boolean> {
  try {
    await VoucherLedger.create({
      ...params,
      walletAddress: params.walletAddress.toLowerCase(),
      timestamp: new Date(),
    });
    return true;
  } catch (err: any) {
    if (isDup(err)) {
      logger.info(`VoucherLedger entry ${params.entryKey} already recorded — skipping.`);
      return false;
    }
    throw err;
  }
}

/**
 * Credit (delta > 0) or debit (delta < 0) a balance. A debit that would take the
 * balance below zero is rejected atomically. Idempotent on `entryKey`.
 */
export async function applyBalanceDelta(params: {
  walletAddress: string;
  token: VoucherToken;
  delta: number;
  reason: VoucherLedgerReason;
  entryKey: string;
  voucherId?: string;
  adminUsername?: string;
  note?: string;
}): Promise<{ balanceAfter: number; applied: boolean }> {
  const wallet = params.walletAddress.toLowerCase();
  const delta = round2(params.delta);

  // If this entryKey was already applied, return the current balance unchanged.
  const existing = await VoucherLedger.findOne({ walletAddress: wallet, entryKey: params.entryKey });
  if (existing) {
    const row = await VoucherBalance.findOne({ walletAddress: wallet, token: params.token });
    return { balanceAfter: row?.balance ?? 0, applied: false };
  }

  await ensureBalanceRow(wallet, params.token);

  const inc: Record<string, number> = { balance: delta };
  if (delta > 0 && params.reason === 'ADMIN_CREDIT') inc.creditedTotal = delta;
  if (delta < 0 && params.reason === 'ADMIN_DEBIT') inc.debitedTotal = -delta;
  if (delta < 0 && params.reason === 'VOUCHER_ISSUE') inc.issued = -delta;
  if (delta > 0 && params.reason === 'VOUCHER_EXPIRY_REFUND') {
    inc.issued = -delta;
    inc.refunded = delta;
  }
  if (delta > 0 && params.reason === 'VOUCHER_REVOKE_REFUND') {
    inc.issued = -delta;
    inc.refunded = delta;
  }

  const filter: Record<string, unknown> = { walletAddress: wallet, token: params.token };
  if (delta < 0) filter.balance = { $gte: -delta };

  const updated = await VoucherBalance.findOneAndUpdate(filter, { $inc: inc }, { new: true });
  if (!updated) {
    throw new VoucherBalanceError(
      'INSUFFICIENT_BALANCE',
      `Not enough ${params.token} balance for this operation.`,
      400,
    );
  }

  const balanceAfter = round2(updated.balance);
  await appendLedger({
    walletAddress: wallet,
    token: params.token,
    entryKey: params.entryKey,
    delta,
    balanceAfter,
    reason: params.reason,
    voucherId: params.voucherId,
    adminUsername: params.adminUsername,
    note: params.note,
  });

  return { balanceAfter, applied: true };
}

/**
 * Rebuild the denormalized `balance` from the ledger sum. Self-healing for a
 * crash between the atomic $inc and the ledger append (the ledger is the source
 * of truth). Returns whether a repair was made.
 */
export async function recalculateBalance(
  walletAddress: string,
  token: VoucherToken,
): Promise<{ before: number; after: number; repaired: boolean }> {
  const wallet = walletAddress.toLowerCase();
  const rows = await VoucherLedger.find({ walletAddress: wallet, token }).lean();
  const sum = round2(rows.reduce((acc, r) => acc + (r.delta || 0), 0));

  const balRow = await ensureBalanceRow(wallet, token);
  const before = round2(balRow?.balance ?? 0);
  if (Math.abs(before - sum) < 0.005) return { before, after: before, repaired: false };

  await VoucherBalance.updateOne(
    { walletAddress: wallet, token },
    { $set: { balance: Math.max(0, sum) } },
  );
  logger.warn(
    `VoucherBalance repaired for ${wallet}/${token}: ${before} -> ${sum} (ledger sum authoritative).`,
  );
  return { before, after: Math.max(0, sum), repaired: true };
}

export async function getBalances(walletAddress: string): Promise<
  { token: VoucherToken; balance: number; issued: number; refunded: number; granted: number }[]
> {
  const wallet = walletAddress.toLowerCase();
  const rows = await VoucherBalance.find({ walletAddress: wallet }).lean();
  const byToken = new Map(rows.map((r) => [r.token, r]));
  return (['USDT', 'USDC'] as VoucherToken[]).map((token) => {
    const r = byToken.get(token);
    return {
      token,
      balance: round2(r?.balance ?? 0),
      issued: round2(r?.issued ?? 0),
      refunded: round2(r?.refunded ?? 0),
      // Net promo credit an admin has handed this account (lifetime credits − debits).
      granted: round2((r?.creditedTotal ?? 0) - (r?.debitedTotal ?? 0)),
    };
  });
}
