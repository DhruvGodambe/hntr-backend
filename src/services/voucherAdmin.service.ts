import Voucher from '../models/Voucher';
import VoucherAccount from '../models/VoucherAccount';
import VoucherBalance from '../models/VoucherBalance';
import VoucherLedger from '../models/VoucherLedger';
import VoucherAdminAudit from '../models/VoucherAdminAudit';
import AchievementBonus from '../models/AchievementBonus';
import User from '../models/User';
import { UserService } from './user.service';
import { getBurnerHealth, hntrContract, provider } from './contract.service';
import { applyBalanceDelta, recalculateBalance, getBalances } from './voucherBalance';
import { VoucherService, VoucherError } from './voucher.service';
import { VoucherToken } from '../constants';
import { parsePagination, paginatedResponse, sanitizeSearch } from '../utils/pagination';
import { logger } from '../utils/logger';

export class VoucherAdminService {
  // ── accounts ─────────────────────────────────────────────────────────────
  static async listAccounts(query: Record<string, unknown>) {
    const { page, limit, skip } = parsePagination(query);
    const filter: Record<string, unknown> = {};
    const search = sanitizeSearch(query.search);
    if (search) filter.$or = [{ username: new RegExp(search, 'i') }, { walletAddress: new RegExp(search, 'i') }];
    if (query.enabled === 'true') filter.enabled = true;
    if (query.enabled === 'false') filter.enabled = false;

    const [accounts, total] = await Promise.all([
      VoucherAccount.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      VoucherAccount.countDocuments(filter),
    ]);

    const items = await Promise.all(
      accounts.map(async (a) => {
        const [balances, activeCount, redeemedCount] = await Promise.all([
          getBalances(a.walletAddress),
          Voucher.countDocuments({ issuerWallet: a.walletAddress, status: 'ACTIVE' }),
          Voucher.countDocuments({ issuerWallet: a.walletAddress, status: 'REDEEMED' }),
        ]);
        return {
          username: a.username,
          walletAddress: a.walletAddress,
          enabled: a.enabled,
          balances,
          issuedTotal: balances.reduce((s, b) => s + b.issued, 0),
          grantedTotal: balances.reduce((s, b) => s + b.granted, 0),
          activeCount,
          redeemedCount,
        };
      }),
    );
    return paginatedResponse(items, total, page, limit);
  }

  static async setAccess(
    adminUsername: string,
    username: string,
    enabled: boolean,
    reason?: string,
  ) {
    const user = await UserService.getUserByUsername(username);
    if (!user) throw new VoucherError('USER_NOT_FOUND', `No user "${username}".`, 404);
    if (!user.walletAddress) {
      throw new VoucherError('NO_WALLET', `${username} has no wallet address on file.`, 400);
    }
    const wallet = user.walletAddress.toLowerCase();

    const now = new Date();
    const update = enabled
      ? { enabled: true, username: user.username, enabledAt: now, enabledBy: adminUsername }
      : {
          enabled: false,
          username: user.username,
          disabledAt: now,
          disabledBy: adminUsername,
          disabledReason: reason,
        };
    const account = await VoucherAccount.findOneAndUpdate(
      { walletAddress: wallet },
      { $set: update, $setOnInsert: { walletAddress: wallet } },
      { upsert: true, new: true },
    );

    await VoucherAdminAudit.create({
      adminUsername,
      action: enabled ? 'ENABLE_ACCESS' : 'DISABLE_ACCESS',
      targetWallet: wallet,
      targetUsername: user.username,
      reason,
    });

    return {
      username: account!.username,
      walletAddress: account!.walletAddress,
      enabled: account!.enabled,
    };
  }

  static async adjustBalance(
    adminUsername: string,
    username: string,
    token: string,
    delta: number,
    note?: string,
  ) {
    const user = await UserService.getUserByUsername(username);
    if (!user?.walletAddress) {
      throw new VoucherError('USER_NOT_FOUND', `No user "${username}" with a wallet.`, 404);
    }
    const tk = String(token).toUpperCase() as VoucherToken;
    if (tk !== 'USDT' && tk !== 'USDC') throw new VoucherError('UNSUPPORTED_TOKEN', 'token must be USDT or USDC');
    const amount = Math.round(Number(delta) * 100) / 100;
    if (!Number.isFinite(amount) || amount === 0) {
      throw new VoucherError('INVALID_DELTA', 'delta must be a non-zero number.');
    }
    const wallet = user.walletAddress.toLowerCase();

    // Audit row first — its _id becomes the ledger idempotency key.
    const audit = await VoucherAdminAudit.create({
      adminUsername,
      action: amount > 0 ? 'CREDIT_BALANCE' : 'DEBIT_BALANCE',
      targetWallet: wallet,
      targetUsername: user.username,
      token: tk,
      delta: amount,
      reason: note,
    });

    const result = await applyBalanceDelta({
      walletAddress: wallet,
      token: tk,
      delta: amount,
      reason: amount > 0 ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT',
      entryKey: `ADMIN:${audit._id}`,
      adminUsername,
      note,
    });

    return { username: user.username, token: tk, balance: result.balanceAfter, delta: amount };
  }

  // ── vouchers ─────────────────────────────────────────────────────────────
  static async listVouchers(query: Record<string, unknown>) {
    const { page, limit, skip } = parsePagination(query);
    const filter: Record<string, unknown> = {};
    if (query.status && query.status !== 'all') filter.status = String(query.status).toUpperCase();
    if (query.issuer) filter.issuerUsername = new RegExp(sanitizeSearch(query.issuer), 'i');
    const search = sanitizeSearch(query.search);
    if (search) {
      filter.$or = [
        { issuerUsername: new RegExp(search, 'i') },
        { redeemerUsername: new RegExp(search, 'i') },
        { codeLast4: new RegExp(search, 'i') },
      ];
    }

    const [rows, total] = await Promise.all([
      Voucher.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Voucher.countDocuments(filter),
    ]);
    const items = rows.map((v) => ({
      voucherId: v.voucherId,
      codeLast4: v.codeLast4,
      issuerUsername: v.issuerUsername,
      issuerWallet: v.issuerWallet,
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
    }));
    return paginatedResponse(items, total, page, limit);
  }

  static async revokeVoucher(adminUsername: string, voucherId: string, reason: string) {
    const result = await VoucherService.revokeInternal(voucherId, adminUsername, reason);
    await VoucherAdminAudit.create({
      adminUsername,
      action: 'REVOKE_VOUCHER',
      voucherId,
      reason,
    });
    return result;
  }

  // ── ledger ───────────────────────────────────────────────────────────────
  static async listLedger(query: Record<string, unknown>) {
    const { page, limit, skip } = parsePagination(query);
    const filter: Record<string, unknown> = {};
    if (query.walletAddress) filter.walletAddress = String(query.walletAddress).toLowerCase();
    if (query.token) filter.token = String(query.token).toUpperCase();

    const [rows, total] = await Promise.all([
      VoucherLedger.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      VoucherLedger.countDocuments(filter),
    ]);

    const walletAddresses = [...new Set(rows.map((r) => r.walletAddress.toLowerCase()))];
    const users = walletAddresses.length
      ? await User.find({ walletAddress: { $in: walletAddresses } }).select('walletAddress username').lean()
      : [];
    const usernameByWallet = new Map(users.map((u) => [u.walletAddress.toLowerCase(), u.username]));

    const items = rows.map((r) => ({
      ...r,
      username: usernameByWallet.get(r.walletAddress.toLowerCase()) ?? null,
    }));

    return paginatedResponse(items, total, page, limit);
  }

  // ── burner wallet ────────────────────────────────────────────────────────
  static async getBurner() {
    return getBurnerHealth();
  }

  static async recordBurnerRotation(adminUsername: string, txHash: string, burnerWallet: string) {
    // Confirm the tx really set burnerWallet to the claimed address.
    let onChain: string;
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) throw new Error('tx not confirmed successfully');
      onChain = await hntrContract.burnerWallet();
    } catch (err: any) {
      throw new VoucherError('BURNER_TX_UNVERIFIED', `Could not verify the rotation tx: ${err.message}`, 400);
    }
    const matches = onChain.toLowerCase() === String(burnerWallet).toLowerCase();

    await VoucherAdminAudit.create({
      adminUsername,
      action: 'SET_BURNER_WALLET',
      targetWallet: onChain.toLowerCase(),
      txHash: String(txHash).toLowerCase(),
      reason: matches ? undefined : 'on-chain address does not match the claimed value',
    });

    return {
      burnerWallet: onChain,
      txHash,
      matches,
      message: matches
        ? 'Burner wallet rotation recorded. Update BURNER_WALLET_PRIVATE_KEY in the backend env and restart.'
        : 'Recorded, but the on-chain burner does not match the address you supplied — check the tx.',
    };
  }

  // ── reconcile ────────────────────────────────────────────────────────────
  static async reconcile(adminUsername: string, opts: { username?: string; token?: string }) {
    let wallets: string[];
    if (opts.username) {
      const user = await UserService.getUserByUsername(opts.username);
      if (!user?.walletAddress) throw new VoucherError('USER_NOT_FOUND', 'No such user with a wallet.', 404);
      wallets = [user.walletAddress.toLowerCase()];
    } else {
      wallets = (await VoucherBalance.distinct('walletAddress')) as string[];
    }
    const tokens: VoucherToken[] = opts.token
      ? [String(opts.token).toUpperCase() as VoucherToken]
      : ['USDT', 'USDC'];

    let checked = 0;
    let repaired = 0;
    for (const wallet of wallets) {
      for (const token of tokens) {
        checked += 1;
        const r = await recalculateBalance(wallet, token);
        if (r.repaired) repaired += 1;
      }
    }
    await VoucherAdminAudit.create({
      adminUsername,
      action: 'RECONCILE_BALANCE',
      targetUsername: opts.username,
      reason: `checked ${checked}, repaired ${repaired}`,
    });
    return { checked, repaired };
  }

  // ── achievement-bonus review queue (Phase 5) ─────────────────────────────
  static async listBonusReview(query: Record<string, unknown>) {
    const { page, limit, skip } = parsePagination(query);
    const status = (
      query.status ? String(query.status).toUpperCase() : 'PENDING_REVIEW'
    ) as 'PENDING' | 'PENDING_REVIEW' | 'PAID' | 'FAILED' | 'REJECTED';
    const [items, total] = await Promise.all([
      AchievementBonus.find({ status }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AchievementBonus.countDocuments({ status }),
    ]);
    return paginatedResponse(items, total, page, limit);
  }

  static async reviewBonus(adminUsername: string, id: string, decision: 'approve' | 'reject', reason?: string) {
    const nextStatus = decision === 'approve' ? 'PENDING' : 'REJECTED';
    const bonus = await AchievementBonus.findOneAndUpdate(
      { _id: id, status: 'PENDING_REVIEW' },
      { $set: { status: nextStatus, reviewedBy: adminUsername, reviewedAt: new Date(), reviewReason: reason } },
      { new: true },
    );
    if (!bonus) throw new VoucherError('BONUS_NOT_IN_REVIEW', 'That bonus is not awaiting review.', 404);

    await VoucherAdminAudit.create({
      adminUsername,
      action: 'REVIEW_ACHIEVEMENT_BONUS',
      targetUsername: bonus.username,
      targetWallet: bonus.walletAddress,
      reason: `${decision}: ${bonus.rank} $${bonus.amountUSD}${reason ? ` — ${reason}` : ''}`,
    });
    return {
      id: String(bonus._id),
      status: bonus.status,
      username: bonus.username,
      rank: bonus.rank,
      amountUSD: bonus.amountUSD,
    };
  }

  static async ownerWallet() {
    try {
      const address: string = await hntrContract.owner();
      return { address };
    } catch (err: any) {
      logger.warn(`ownerWallet read failed: ${err.message}`);
      return { address: null };
    }
  }
}
