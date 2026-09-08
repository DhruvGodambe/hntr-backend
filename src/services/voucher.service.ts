import { ethers } from 'ethers';
import Voucher, { IVoucher } from '../models/Voucher';
import VoucherAccount from '../models/VoucherAccount';
import VoucherRedeemAttempt from '../models/VoucherRedeemAttempt';
import Transaction from '../models/Transaction';
import User from '../models/User';
import { UserService } from './user.service';
import { NotificationService } from './notification.service';
import {
  hntrContract,
  hntrContractWithBurnerSigner,
  burnerWallet as burnerSignerWallet,
} from './contract.service';
import { applyBalanceDelta, getBalances } from './voucherBalance';
import {
  Tier,
  TIER_INDEX,
  TIER_VOLUMES,
  VOUCHER_EXPIRY_DAYS,
  VOUCHER_TIERS,
  VoucherToken,
} from '../constants';
import { logger } from '../utils/logger';
import * as code from '../utils/voucherCode';
import { parsePagination, paginatedResponse } from '../utils/pagination';

export class VoucherError extends Error {
  code: string;
  statusCode: number;
  constructor(codeName: string, message: string, statusCode = 400) {
    super(message);
    this.code = codeName;
    this.statusCode = statusCode;
  }
}

const TIER_BY_INDEX: Tier[] = [
  Tier.NONE,
  Tier.BRONZE,
  Tier.SILVER,
  Tier.GOLD,
  Tier.PLATINUM,
  Tier.DIAMOND,
];

const REDEEM_LOCKOUT_FAILURES = 10;
const REDEEM_LOCKOUT_MS = 30 * 60 * 1000;

function newVoucherId(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}

function publicVoucher(v: IVoucher) {
  return {
    voucherId: v.voucherId,
    codeLast4: v.codeLast4,
    tier: v.tier,
    amountUsd: v.amountUsd,
    token: v.token,
    status: v.status,
    note: v.note ?? null,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    redeemedAt: v.redeemedAt ?? null,
    redeemerUsername: v.redeemerUsername ?? null,
    txHash: v.txHash ?? null,
  };
}

export class VoucherService {
  // ── access ────────────────────────────────────────────────────────────────
  static async getAccess(walletAddress: string) {
    const wallet = walletAddress.toLowerCase();
    const account = await VoucherAccount.findOne({ walletAddress: wallet });
    const user = await UserService.getUserByWallet(wallet);
    return {
      enabled: !!account?.enabled,
      username: user?.username ?? account?.username ?? null,
      balances: await getBalances(wallet),
      expiryDays: VOUCHER_EXPIRY_DAYS,
      tiers: VOUCHER_TIERS.map((t) => ({ name: t.tier, valueUsd: t.valueUsd })),
    };
  }

  private static async assertEnabled(walletAddress: string) {
    const account = await VoucherAccount.findOne({ walletAddress: walletAddress.toLowerCase() });
    if (!account?.enabled) {
      throw new VoucherError('VOUCHER_ACCESS_DENIED', 'Your account is not enabled to issue gift codes.', 403);
    }
    return account;
  }

  // ── list issuer's own ─────────────────────────────────────────────────────
  static async listMine(walletAddress: string, query: Record<string, unknown>) {
    const wallet = walletAddress.toLowerCase();
    const { page, limit, skip } = parsePagination(query);
    const filter: Record<string, unknown> = { issuerWallet: wallet };
    if (query.status && query.status !== 'all') filter.status = String(query.status).toUpperCase();

    const [items, total] = await Promise.all([
      Voucher.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Voucher.countDocuments(filter),
    ]);
    return paginatedResponse(items.map(publicVoucher), total, page, limit);
  }

  // ── issue ─────────────────────────────────────────────────────────────────
  static async issue(
    walletAddress: string,
    input: { tier: string; token: string; note?: string },
  ) {
    const wallet = walletAddress.toLowerCase();
    const account = await this.assertEnabled(wallet);

    const tierName = TIER_BY_INDEX.find(
      (t) => t !== Tier.NONE && t.toLowerCase() === String(input.tier).toLowerCase(),
    );
    if (!tierName) throw new VoucherError('INVALID_TIER', `Not a valid membership tier: ${input.tier}`);

    const token = String(input.token || '').toUpperCase() as VoucherToken;
    if (token !== 'USDT' && token !== 'USDC') {
      throw new VoucherError('UNSUPPORTED_TOKEN', 'token must be USDT or USDC');
    }

    const amountUsd = TIER_VOLUMES[tierName];
    const tierIndex = TIER_INDEX[tierName];
    const note = input.note ? String(input.note).slice(0, 64) : undefined;

    const voucherId = newVoucherId();
    const plaintext = code.generateCode();
    const normalized = code.normalize(plaintext);

    // Debit first (atomic; rejects if short). Compensate if the insert then fails.
    const debit = await applyBalanceDelta({
      walletAddress: wallet,
      token,
      delta: -amountUsd,
      reason: 'VOUCHER_ISSUE',
      entryKey: `VOUCHER_ISSUE:${voucherId}`,
      voucherId,
      note,
    });

    let voucher: IVoucher;
    try {
      voucher = await Voucher.create({
        voucherId,
        codeHash: code.hmac(normalized),
        codeCipher: code.encrypt(normalized),
        codeLast4: code.last4(normalized),
        issuerWallet: wallet,
        issuerUsername: account.username,
        tier: tierName as IVoucher['tier'],
        tierIndex,
        amountUsd,
        token,
        status: 'ACTIVE',
        note,
        expiresAt: new Date(Date.now() + VOUCHER_EXPIRY_DAYS * 86400 * 1000),
        redeemAttempts: 0,
      });
    } catch (err: any) {
      await applyBalanceDelta({
        walletAddress: wallet,
        token,
        delta: amountUsd,
        reason: 'VOUCHER_REVOKE_REFUND',
        entryKey: `VOUCHER_ISSUE_ROLLBACK:${voucherId}`,
        voucherId,
        note: 'issue insert failed',
      }).catch(() => undefined);
      throw err;
    }

    return {
      voucherId,
      code: plaintext,
      redeemUrl: code.redeemUrl(plaintext),
      tier: tierName,
      amountUsd,
      token,
      expiresAt: voucher.expiresAt,
      balanceAfter: debit.balanceAfter,
    };
  }

  // ── reveal (issuer only) ──────────────────────────────────────────────────
  static async revealCode(walletAddress: string, voucherId: string) {
    const v = await Voucher.findOne({ voucherId });
    if (!v || v.issuerWallet !== walletAddress.toLowerCase()) {
      throw new VoucherError('VOUCHER_NOT_FOUND', 'Voucher not found.', 404);
    }
    if (v.status === 'REDEEMED' || v.status === 'REVOKED' || v.status === 'EXPIRED') {
      throw new VoucherError('VOUCHER_NOT_ACTIVE', `This voucher is ${v.status.toLowerCase()}.`);
    }
    const plaintext = code.decrypt(v.codeCipher);
    return { code: plaintext, redeemUrl: code.redeemUrl(plaintext) };
  }

  // ── share (issuer only) → in-app notifications ────────────────────────────
  static async share(walletAddress: string, voucherId: string, usernames: string[]) {
    const v = await Voucher.findOne({ voucherId });
    if (!v || v.issuerWallet !== walletAddress.toLowerCase()) {
      throw new VoucherError('VOUCHER_NOT_FOUND', 'Voucher not found.', 404);
    }
    if (v.status !== 'ACTIVE') {
      throw new VoucherError('VOUCHER_NOT_ACTIVE', `This voucher is ${v.status.toLowerCase()}.`);
    }
    const list = [...new Set((usernames || []).map((u) => String(u).trim().toLowerCase()).filter(Boolean))].slice(0, 25);
    const plaintext = code.decrypt(v.codeCipher);
    const url = code.redeemUrl(plaintext);

    const notified: string[] = [];
    const skipped: { username: string; reason: string }[] = [];
    for (const uname of list) {
      const target = await User.findOne({ username: uname });
      if (!target?.walletAddress) {
        skipped.push({ username: uname, reason: 'unknown user' });
        continue;
      }
      await NotificationService.createQuiet({
        walletAddress: target.walletAddress,
        type: 'VOUCHER_RECEIVED',
        title: `${v.tier} membership gift code`,
        sub: `${v.issuerUsername} sent you a ${v.tier} membership voucher. Redeem it before it expires.`,
        link: 'REDEEM NOW',
        meta: { voucherId, tier: v.tier, redeemUrl: url, from: v.issuerUsername, expiresAt: v.expiresAt },
      });
      notified.push(uname);
    }
    return { notified, skipped };
  }

  // ── revoke (issuer) ──────────────────────────────────────────────────────
  static async revoke(walletAddress: string, voucherId: string) {
    return this.revokeInternal(voucherId, 'issuer', undefined, walletAddress.toLowerCase());
  }

  static async revokeInternal(
    voucherId: string,
    by: string,
    reason?: string,
    issuerWalletGuard?: string,
  ) {
    const claimed = await Voucher.findOneAndUpdate(
      {
        voucherId,
        status: 'ACTIVE',
        ...(issuerWalletGuard ? { issuerWallet: issuerWalletGuard } : {}),
      },
      { $set: { status: 'REVOKED', revokedAt: new Date(), revokedBy: by, revokeReason: reason } },
      { new: true },
    );
    if (!claimed) {
      const exists = await Voucher.findOne({ voucherId });
      if (!exists) throw new VoucherError('VOUCHER_NOT_FOUND', 'Voucher not found.', 404);
      if (issuerWalletGuard && exists.issuerWallet !== issuerWalletGuard) {
        throw new VoucherError('VOUCHER_NOT_FOUND', 'Voucher not found.', 404);
      }
      throw new VoucherError('VOUCHER_NOT_ACTIVE', `This voucher is ${exists.status.toLowerCase()}.`);
    }

    const refund = await applyBalanceDelta({
      walletAddress: claimed.issuerWallet,
      token: claimed.token,
      delta: claimed.amountUsd,
      reason: 'VOUCHER_REVOKE_REFUND',
      entryKey: `VOUCHER_REVOKE_REFUND:${voucherId}`,
      voucherId,
      adminUsername: by === 'issuer' ? undefined : by,
      note: reason,
    });

    return { voucherId, status: 'REVOKED' as const, refunded: claimed.amountUsd, balanceAfter: refund.balanceAfter };
  }

  // ── redeem (bearer) ──────────────────────────────────────────────────────
  static async redeem(redeemerWallet: string, rawCode: string, ip?: string) {
    if (!hntrContractWithBurnerSigner || !burnerSignerWallet) {
      throw new VoucherError(
        'BURNER_NOT_CONFIGURED',
        'Voucher redemption is temporarily unavailable. Please try again later.',
        503,
      );
    }
    const wallet = redeemerWallet.toLowerCase();
    await this.assertNotLockedOut(wallet, ip);

    const normalized = code.normalize(String(rawCode || ''));
    if (!code.isWellFormed(normalized)) {
      await this.recordFailure(wallet, ip);
      throw new VoucherError('INVALID_CODE', 'That does not look like a valid gift code.');
    }

    // Primary guard: atomic ACTIVE → REDEEMING claim on the hashed code.
    const claimed = await Voucher.findOneAndUpdate(
      { codeHash: code.hmac(normalized), status: 'ACTIVE', expiresAt: { $gt: new Date() } },
      { $set: { status: 'REDEEMING', redeemLockedAt: new Date() }, $inc: { redeemAttempts: 1 } },
      { new: true },
    );

    if (!claimed) {
      await this.recordFailure(wallet, ip);
      const known = await Voucher.findOne({ codeHash: code.hmac(normalized) });
      if (!known) throw new VoucherError('INVALID_CODE', 'That gift code is not recognised.');
      if (known.status === 'REDEEMED') throw new VoucherError('ALREADY_REDEEMED', 'This gift code has already been redeemed.');
      if (known.status === 'EXPIRED' || known.expiresAt <= new Date()) {
        throw new VoucherError('EXPIRED', 'This gift code has expired.');
      }
      if (known.status === 'REVOKED') throw new VoucherError('REVOKED', 'This gift code was cancelled.');
      if (known.status === 'REDEEMING') throw new VoucherError('IN_PROGRESS', 'This gift code is already being redeemed.');
      throw new VoucherError('NOT_REDEEMABLE', `This gift code is ${known.status.toLowerCase()}.`);
    }

    // The redeemer must be a real member so the tier attaches to a known network node.
    const user = await UserService.getUserByWallet(wallet);
    if (!user) {
      await this.releaseClaim(claimed);
      throw new VoucherError(
        'USER_NOT_REGISTERED',
        'Create your account first, then redeem the code.',
        409,
      );
    }

    // Strict upgrade-only, checked against the chain (source of truth).
    const onChain = await hntrContract.getUser(wallet);
    const currentTierIndex = Number(onChain.tier);
    if (claimed.tierIndex <= currentTierIndex) {
      await this.releaseClaim(claimed);
      throw new VoucherError(
        'NOT_AN_UPGRADE',
        `Your membership (${TIER_BY_INDEX[currentTierIndex]}) is already at or above ${claimed.tier}.`,
      );
    }
    if (await hntrContract.voucherRedeemed(claimed.voucherId)) {
      // On-chain replay guard already tripped — reconcile and stop.
      claimed.status = 'REDEEMED';
      claimed.redeemerWallet = wallet;
      claimed.redeemerUsername = user.username;
      await claimed.save();
      throw new VoucherError('ALREADY_REDEEMED', 'This gift code has already been redeemed.');
    }

    // Send the tx from the burner. The redeemer signs nothing and pays no gas.
    let receipt: ethers.TransactionReceipt | null;
    try {
      const tx = await hntrContractWithBurnerSigner.redeemVoucher(
        claimed.voucherId,
        wallet,
        claimed.tierIndex,
      );
      receipt = await tx.wait();
    } catch (err: any) {
      logger.error(`redeemVoucher tx failed for ${claimed.voucherId}: ${err.message}`);
      await this.releaseClaim(claimed);
      await this.recordFailure(wallet, ip);
      throw new VoucherError('REDEEM_FAILED', 'The redemption could not be completed. Please try again.', 502);
    }

    const txHash = (receipt?.hash || '').toLowerCase();
    const tierBefore = TIER_BY_INDEX[currentTierIndex];

    claimed.status = 'REDEEMED';
    claimed.redeemerWallet = wallet;
    claimed.redeemerUsername = user.username;
    claimed.redeemedAt = new Date();
    claimed.txHash = txHash;
    claimed.tierBefore = tierBefore;
    claimed.redeemLockedAt = undefined;
    await claimed.save();

    await this.clearFailures(wallet, ip);

    // The VoucherRedeemed event handler does the authoritative User/tier/volume
    // update and writes the Transaction row. Write an optimistic row now so the
    // UI reflects it immediately; the handler upserts by (txHash, wallet, type).
    try {
      await Transaction.create({
        txHash,
        walletAddress: wallet,
        type: 'VOUCHER_MEMBERSHIP_REDEEM',
        tier: claimed.tier,
        amount: claimed.amountUsd,
        status: 'CONFIRMED',
        timestamp: new Date(),
      });
    } catch (err: any) {
      if (err?.code !== 11000) logger.warn(`voucher redeem tx row: ${err.message}`);
    }

    await NotificationService.createQuiet({
      walletAddress: v_notifyIssuer(claimed) ? claimed.issuerWallet : wallet,
      type: 'VOUCHER_REDEEMED',
      title: 'Gift code redeemed',
      sub: `${user.username} redeemed your ${claimed.tier} membership voucher.`,
      link: 'VIEW GIFT CODES',
      meta: { voucherId: claimed.voucherId, tier: claimed.tier, redeemer: user.username, txHash },
    });

    return {
      voucherId: claimed.voucherId,
      tier: claimed.tier,
      tierBefore,
      txHash,
      amountUsd: claimed.amountUsd,
    };
  }

  private static async releaseClaim(v: IVoucher) {
    await Voucher.updateOne(
      { _id: v._id, status: 'REDEEMING' },
      { $set: { status: 'ACTIVE' }, $unset: { redeemLockedAt: 1 } },
    );
  }

  // ── brute-force lockout (persisted) ──────────────────────────────────────
  private static keysFor(wallet: string, ip?: string): string[] {
    const keys = [`wallet:${wallet}`];
    if (ip) keys.push(`ip:${ip}`);
    return keys;
  }

  private static async assertNotLockedOut(wallet: string, ip?: string) {
    const rows = await VoucherRedeemAttempt.find({ key: { $in: this.keysFor(wallet, ip) } });
    const now = Date.now();
    for (const r of rows) {
      if (r.lockedUntil && r.lockedUntil.getTime() > now) {
        throw new VoucherError(
          'REDEEM_LOCKED',
          'Too many failed attempts. Try again later.',
          429,
        );
      }
    }
  }

  private static async recordFailure(wallet: string, ip?: string) {
    for (const key of this.keysFor(wallet, ip)) {
      const row = await VoucherRedeemAttempt.findOneAndUpdate(
        { key },
        { $inc: { failures: 1 }, $set: { lastAttempt: new Date() }, $setOnInsert: { windowStart: new Date() } },
        { upsert: true, new: true },
      );
      if (row.failures >= REDEEM_LOCKOUT_FAILURES) {
        row.lockedUntil = new Date(Date.now() + REDEEM_LOCKOUT_MS);
        await row.save();
      }
    }
  }

  private static async clearFailures(wallet: string, ip?: string) {
    await VoucherRedeemAttempt.deleteMany({ key: { $in: this.keysFor(wallet, ip) } });
  }
}

/** A voucher's issuer gets the "redeemed" notification unless they redeemed their own. */
function v_notifyIssuer(v: IVoucher): boolean {
  return v.issuerWallet !== (v.redeemerWallet || '').toLowerCase();
}

export { VOUCHER_EXPIRY_DAYS };
export const _forTests = { newVoucherId, TIER_BY_INDEX };
