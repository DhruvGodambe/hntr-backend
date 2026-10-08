import { ethers } from 'ethers';
import PriorityLineDeposit, { IPriorityLineDeposit, PriorityLineStatus } from '../models/PriorityLineDeposit';
import AdminSettings from '../models/AdminSettings';
import Counter from '../models/Counter';
import User from '../models/User';
import { NotificationService } from './notification.service';
import { getContractAmountDecimals, hntrContract, provider } from './contract.service';
import { PRIORITY_LINE_MIN_DEPOSIT_USD, PRIORITY_LINE_TIER_CAPS, Tier } from '../constants';
import { parsePagination, paginatedResponse, sanitizeSearch } from '../utils/pagination';
import { logger } from '../utils/logger';

export type PriorityToken = 'USDT' | 'USDC';

export class PriorityLineError extends Error {
  code: string;
  statusCode: number;
  constructor(codeName: string, message: string, statusCode = 400) {
    super(message);
    this.code = codeName;
    this.statusCode = statusCode;
  }
}

const COUNTER_KEY = 'priorityLine';
const COUNTED_STATUSES: PriorityLineStatus[] = ['ACTIVE', 'WITHDRAWAL_REQUESTED'];
const EPS = 1e-9;
const TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const TRANSFER_TOPIC = TRANSFER_IFACE.getEvent('Transfer')!.topicHash;

// Serialises cap-sensitive work per wallet so two simultaneous confirmations from the
// same user can't both pass the cap check. (Single-process only.)
const walletLocks = new Map<string, Promise<unknown>>();
async function withWalletLock<T>(wallet: string, fn: () => Promise<T>): Promise<T> {
  const prev = walletLocks.get(wallet) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  walletLocks.set(wallet, tail);
  try {
    return await run;
  } finally {
    if (walletLocks.get(wallet) === tail) walletLocks.delete(wallet);
  }
}

function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function normToken(raw: unknown): PriorityToken {
  const t = String(raw ?? '').toUpperCase();
  if (t !== 'USDT' && t !== 'USDC') throw new PriorityLineError('UNSUPPORTED_TOKEN', 'Token must be USDT or USDC');
  return t;
}

async function resolveTokenAddress(token: PriorityToken): Promise<string> {
  return token === 'USDT' ? hntrContract.usdt() : hntrContract.usdc();
}

function dto(d: IPriorityLineDeposit | Record<string, any>) {
  return {
    id: String(d._id),
    lineNumber: d.lineNumber ?? null,
    token: d.token as PriorityToken,
    amountUsd: d.amountUsd as number,
    txHash: d.txHash as string,
    status: d.status as PriorityLineStatus,
    createdAt: d.createdAt as Date,
    withdrawalRequestedAt: (d.withdrawalRequestedAt as Date | undefined) ?? null,
    withdrawnAt: (d.withdrawnAt as Date | undefined) ?? null,
    payoutTxHash: (d.payoutTxHash as string | undefined) ?? null,
  };
}

async function getSettingsDoc() {
  return AdminSettings.findOne({ key: 'global' }).lean();
}

async function getUsedUsd(wallet: string): Promise<number> {
  const rows = await PriorityLineDeposit.find({ walletAddress: wallet, status: { $in: COUNTED_STATUSES } })
    .select('amountUsd')
    .lean();
  return roundUsd(rows.reduce((t, r) => t + r.amountUsd, 0));
}

async function getCap(wallet: string): Promise<{ tier: Tier; cap: number }> {
  const user = await User.findOne({ walletAddress: wallet }).select('tier').lean();
  const tier = (user?.tier as Tier | undefined) ?? Tier.NONE;
  return { tier, cap: PRIORITY_LINE_TIER_CAPS[tier] ?? 0 };
}

async function nextLineNumber(): Promise<number> {
  const c = await Counter.findOneAndUpdate({ key: COUNTER_KEY }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return c.seq;
}

export class PriorityLineService {
  // ── member ───────────────────────────────────────────────────────────────
  static async getOverview(walletAddress: string) {
    const wallet = walletAddress.toLowerCase();
    const [{ tier, cap }, settings, rows] = await Promise.all([
      getCap(wallet),
      getSettingsDoc(),
      PriorityLineDeposit.find({ walletAddress: wallet }).sort({ createdAt: -1 }).lean(),
    ]);
    const counted = rows.filter((r) => COUNTED_STATUSES.includes(r.status));
    const used = roundUsd(counted.reduce((t, r) => t + r.amountUsd, 0));
    const lineNumbers = counted.map((r) => r.lineNumber).filter((n): n is number => typeof n === 'number');

    return {
      tier,
      cap,
      used,
      remaining: Math.max(0, roundUsd(cap - used)),
      minDepositUsd: PRIORITY_LINE_MIN_DEPOSIT_USD,
      firstLineNumber: lineNumbers.length ? Math.min(...lineNumbers) : null,
      depositWallet: settings?.priorityLineDepositWallet || null,
      deposits: rows.map(dto),
    };
  }

  /** Validates a prospective deposit and tells the client where/what to transfer. Writes nothing. */
  static async prepareDeposit(walletAddress: string, tokenRaw: unknown, amountRaw: unknown) {
    const wallet = walletAddress.toLowerCase();
    const token = normToken(tokenRaw);
    const amount = roundUsd(Number(amountRaw));
    if (!Number.isFinite(amount) || amount <= 0) throw new PriorityLineError('INVALID_AMOUNT', 'Enter a valid amount');
    if (amount < PRIORITY_LINE_MIN_DEPOSIT_USD) {
      throw new PriorityLineError('BELOW_MINIMUM', `Minimum deposit is ${fmtUsd(PRIORITY_LINE_MIN_DEPOSIT_USD)}`);
    }

    const settings = await getSettingsDoc();
    const depositWallet = settings?.priorityLineDepositWallet;
    if (!depositWallet) {
      throw new PriorityLineError('DEPOSITS_NOT_CONFIGURED', 'Priority Line deposits are not open yet', 503);
    }

    const { tier, cap } = await getCap(wallet);
    if (cap <= 0) {
      throw new PriorityLineError('NO_MEMBERSHIP', 'An active membership is required to join the Priority Line', 403);
    }
    const used = await getUsedUsd(wallet);
    const remaining = Math.max(0, roundUsd(cap - used));
    if (amount > remaining + EPS) {
      throw new PriorityLineError(
        'OVER_CAP',
        `Above your ${tier} membership cap. You can reserve up to ${fmtUsd(remaining)} more.`,
      );
    }

    const [tokenAddress, decimals] = await Promise.all([resolveTokenAddress(token), getContractAmountDecimals()]);
    return {
      depositWallet,
      token,
      tokenAddress,
      decimals,
      amountUsd: amount,
      amountRaw: ethers.parseUnits(amount.toFixed(2), decimals).toString(),
      remaining,
    };
  }

  /**
   * Verifies an on-chain ERC20 transfer from the member to the configured deposit wallet and
   * records it. The credited amount always comes from the chain log, never from the client.
   * Idempotent per (txHash, logIndex).
   */
  static async confirmDeposit(walletAddress: string, txHashRaw: unknown, tokenRaw: unknown) {
    const wallet = walletAddress.toLowerCase();
    const token = normToken(tokenRaw);
    const txHash = String(txHashRaw ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new PriorityLineError('INVALID_TX_HASH', 'Invalid transaction hash');

    const settings = await getSettingsDoc();
    const accepted = new Set(
      [settings?.priorityLineDepositWallet, ...(settings?.priorityLineWalletHistory ?? [])]
        .filter((a): a is string => !!a)
        .map((a) => a.toLowerCase()),
    );
    if (!accepted.size) {
      throw new PriorityLineError('DEPOSITS_NOT_CONFIGURED', 'Priority Line deposits are not open yet', 503);
    }

    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new PriorityLineError('TX_NOT_MINED', 'Transaction not confirmed yet — try again in a moment', 409);
    }
    if (receipt.status !== 1) {
      throw new PriorityLineError('TX_FAILED', 'That transaction failed on-chain', 400);
    }

    const tokenAddress = (await resolveTokenAddress(token)).toLowerCase();
    const matches: { logIndex: number; value: bigint; to: string }[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== tokenAddress || log.topics[0] !== TRANSFER_TOPIC) continue;
      let parsed: ethers.LogDescription | null = null;
      try {
        parsed = TRANSFER_IFACE.parseLog({ topics: [...log.topics], data: log.data });
      } catch {
        continue;
      }
      if (!parsed) continue;
      const from = String(parsed.args[0]).toLowerCase();
      const to = String(parsed.args[1]).toLowerCase();
      if (from === wallet && accepted.has(to)) {
        matches.push({ logIndex: Number(log.index), value: parsed.args[2] as bigint, to });
      }
    }
    if (!matches.length) {
      throw new PriorityLineError(
        'TRANSFER_NOT_FOUND',
        `No ${token} transfer from your wallet to the Priority Line wallet was found in that transaction`,
      );
    }

    const decimals = await getContractAmountDecimals();

    return withWalletLock(wallet, async () => {
      const results: IPriorityLineDeposit[] = [];
      for (const m of matches) {
        const existing = await PriorityLineDeposit.findOne({ txHash, logIndex: m.logIndex });
        if (existing) {
          if (existing.walletAddress !== wallet) {
            throw new PriorityLineError('TX_ALREADY_USED', 'That transaction was already credited', 409);
          }
          results.push(existing);
          continue;
        }

        const amountUsd = roundUsd(Number(ethers.formatUnits(m.value, decimals)));
        if (amountUsd < PRIORITY_LINE_MIN_DEPOSIT_USD) {
          throw new PriorityLineError('BELOW_MINIMUM', `Minimum deposit is ${fmtUsd(PRIORITY_LINE_MIN_DEPOSIT_USD)}`);
        }

        const { cap } = await getCap(wallet);
        const used = await getUsedUsd(wallet);
        const fits = used + amountUsd <= cap + EPS;

        const base = {
          walletAddress: wallet,
          token,
          amountUsd,
          amountRaw: m.value.toString(),
          txHash,
          logIndex: m.logIndex,
          depositWallet: m.to,
        };

        let doc: IPriorityLineDeposit;
        try {
          doc = fits
            ? await PriorityLineDeposit.create({ ...base, status: 'ACTIVE', lineNumber: await nextLineNumber() })
            : await PriorityLineDeposit.create({ ...base, status: 'REVIEW' });
        } catch (err: any) {
          if (err?.code === 11000) {
            const dup = await PriorityLineDeposit.findOne({ txHash, logIndex: m.logIndex });
            if (dup && dup.walletAddress === wallet) {
              results.push(dup);
              continue;
            }
            throw new PriorityLineError('TX_ALREADY_USED', 'That transaction was already credited', 409);
          }
          throw err;
        }

        if (fits) {
          logger.info(`Priority Line deposit ${fmtUsd(amountUsd)} ${token} from ${wallet} → line #${doc.lineNumber}`);
          await NotificationService.createQuiet({
            walletAddress: wallet,
            type: 'PRIORITY_LINE_DEPOSIT',
            title: `Priority Line spot reserved — #${doc.lineNumber}`,
            sub: `${fmtUsd(amountUsd)} ${token} deposited`,
            link: '/priority-line',
            meta: { lineNumber: doc.lineNumber, amountUsd, token, txHash },
            dedupeKey: `PRIORITY_LINE_DEPOSIT:${txHash}:${m.logIndex}`,
          });
        } else {
          logger.warn(
            `Priority Line deposit ${fmtUsd(amountUsd)} ${token} from ${wallet} exceeded cap after transfer (tx ${txHash}) — flagged REVIEW`,
          );
          await NotificationService.createQuiet({
            walletAddress: wallet,
            type: 'GENERAL',
            title: 'Priority Line deposit needs review',
            sub: `${fmtUsd(amountUsd)} ${token} went over your cap. Our team will contact you.`,
            link: '/priority-line',
            meta: { amountUsd, token, txHash },
            dedupeKey: `PRIORITY_LINE_REVIEW:${txHash}:${m.logIndex}`,
          });
        }
        results.push(doc);
      }
      return { deposits: results.map(dto) };
    });
  }

  /** Member asks for a deposit back. The admin pays it out manually; cap room stays held until then. */
  static async requestWithdrawal(walletAddress: string, depositId: unknown) {
    const wallet = walletAddress.toLowerCase();
    const id = String(depositId ?? '');
    if (!/^[0-9a-fA-F]{24}$/.test(id)) throw new PriorityLineError('INVALID_DEPOSIT', 'Invalid deposit');

    const doc = await PriorityLineDeposit.findOneAndUpdate(
      { _id: id, walletAddress: wallet, status: 'ACTIVE' },
      { $set: { status: 'WITHDRAWAL_REQUESTED', withdrawalRequestedAt: new Date() } },
      { new: true },
    );
    if (!doc) {
      const exists = await PriorityLineDeposit.exists({ _id: id, walletAddress: wallet });
      if (!exists) throw new PriorityLineError('NOT_FOUND', 'Deposit not found', 404);
      throw new PriorityLineError('NOT_WITHDRAWABLE', 'This deposit can no longer be withdrawn', 409);
    }

    logger.info(`Priority Line withdrawal requested: line #${doc.lineNumber} by ${wallet}`);
    await NotificationService.createQuiet({
      walletAddress: wallet,
      type: 'PRIORITY_LINE_WITHDRAWAL_REQUESTED',
      title: `Withdrawal requested — line #${doc.lineNumber}`,
      sub: `${fmtUsd(doc.amountUsd)} ${doc.token} · pending admin review`,
      link: '/priority-line',
      meta: { lineNumber: doc.lineNumber, amountUsd: doc.amountUsd, token: doc.token },
      dedupeKey: `PRIORITY_LINE_WITHDRAWAL_REQUESTED:${doc.id}:${doc.withdrawalRequestedAt?.getTime()}`,
    });
    return dto(doc);
  }

  // ── admin ────────────────────────────────────────────────────────────────
  static async getSettings() {
    const s = await getSettingsDoc();
    return {
      depositWallet: s?.priorityLineDepositWallet || null,
      walletHistory: s?.priorityLineWalletHistory ?? [],
    };
  }

  static async setDepositWallet(walletRaw: unknown, adminUsername: string) {
    const input = String(walletRaw ?? '').trim();
    if (!ethers.isAddress(input)) throw new PriorityLineError('INVALID_ADDRESS', 'Enter a valid wallet address');
    if (input.toLowerCase() === ethers.ZeroAddress) {
      throw new PriorityLineError('INVALID_ADDRESS', 'The zero address cannot receive deposits');
    }
    const next = input.toLowerCase();
    const current = (await getSettingsDoc())?.priorityLineDepositWallet;
    if (current !== next) {
      const update: Record<string, any> = { $set: { priorityLineDepositWallet: next } };
      if (current) update.$addToSet = { priorityLineWalletHistory: current };
      await AdminSettings.findOneAndUpdate({ key: 'global' }, update, { upsert: true, new: true });
      logger.info(`Priority Line deposit wallet changed ${current ?? '(none)'} → ${next} by ${adminUsername}`);
    }
    return PriorityLineService.getSettings();
  }

  static async getStats() {
    const [counted, pending, withdrawn, review] = await Promise.all([
      PriorityLineDeposit.aggregate([
        { $match: { status: { $in: COUNTED_STATUSES } } },
        { $group: { _id: null, total: { $sum: '$amountUsd' }, count: { $sum: 1 } } },
      ]),
      PriorityLineDeposit.aggregate([
        { $match: { status: 'WITHDRAWAL_REQUESTED' } },
        { $group: { _id: null, total: { $sum: '$amountUsd' }, count: { $sum: 1 } } },
      ]),
      PriorityLineDeposit.aggregate([
        { $match: { status: 'WITHDRAWN' } },
        { $group: { _id: null, total: { $sum: '$amountUsd' }, count: { $sum: 1 } } },
      ]),
      PriorityLineDeposit.countDocuments({ status: 'REVIEW' }),
    ]);
    return {
      totalDepositedUsd: roundUsd(counted[0]?.total ?? 0),
      activeDeposits: counted[0]?.count ?? 0,
      pendingWithdrawals: pending[0]?.count ?? 0,
      pendingWithdrawalsUsd: roundUsd(pending[0]?.total ?? 0),
      withdrawnUsd: roundUsd(withdrawn[0]?.total ?? 0),
      reviewDeposits: review,
    };
  }

  private static async withUsernames(rows: Record<string, any>[]) {
    const wallets = Array.from(new Set(rows.map((r) => r.walletAddress as string)));
    const users = await User.find({ walletAddress: { $in: wallets } })
      .select('walletAddress username')
      .lean();
    const names = new Map(users.map((u) => [u.walletAddress, u.username]));
    return rows.map((r) => ({
      ...dto(r),
      walletAddress: r.walletAddress as string,
      username: names.get(r.walletAddress) ?? null,
      depositWallet: r.depositWallet as string,
      processedBy: (r.processedBy as string | undefined) ?? null,
      adminNote: (r.adminNote as string | undefined) ?? null,
    }));
  }

  static async listDeposits(query: Record<string, unknown>) {
    const { page, limit, skip } = parsePagination(query);
    const filter: Record<string, any> = {};
    const status = String(query.status ?? '');
    if (['ACTIVE', 'WITHDRAWAL_REQUESTED', 'WITHDRAWN', 'REVIEW'].includes(status)) filter.status = status;

    const search = sanitizeSearch(query.search);
    if (search) {
      const rx = new RegExp(search, 'i');
      const matchedUsers = await User.find({ username: rx }).select('walletAddress').limit(50).lean();
      const or: Record<string, any>[] = [
        { walletAddress: rx },
        { txHash: rx },
        { walletAddress: { $in: matchedUsers.map((u) => u.walletAddress) } },
      ];
      if (/^#?\d+$/.test(search)) or.push({ lineNumber: Number(search.replace('#', '')) });
      filter.$or = or;
    }

    const [rows, total] = await Promise.all([
      PriorityLineDeposit.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      PriorityLineDeposit.countDocuments(filter),
    ]);
    return paginatedResponse(await PriorityLineService.withUsernames(rows), total, page, limit);
  }

  /** Withdrawal requests: status=REQUESTED (default, oldest first), WITHDRAWN, or all. */
  static async listWithdrawals(query: Record<string, unknown>) {
    const { page, limit, skip } = parsePagination(query);
    const status = String(query.status ?? 'REQUESTED');
    const filter: Record<string, any> = { withdrawalRequestedAt: { $exists: true } };
    if (status === 'WITHDRAWN') filter.status = 'WITHDRAWN';
    else if (status === 'all') filter.status = { $in: ['WITHDRAWAL_REQUESTED', 'WITHDRAWN'] };
    else filter.status = 'WITHDRAWAL_REQUESTED';

    const sort: Record<string, 1 | -1> = status === 'REQUESTED' || !status ? { withdrawalRequestedAt: 1 } : { withdrawalRequestedAt: -1 };
    const [rows, total] = await Promise.all([
      PriorityLineDeposit.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      PriorityLineDeposit.countDocuments(filter),
    ]);
    return paginatedResponse(await PriorityLineService.withUsernames(rows), total, page, limit);
  }

  static async completeWithdrawal(
    depositId: string,
    adminUsername: string,
    input: { payoutTxHash?: unknown; note?: unknown },
  ) {
    if (!/^[0-9a-fA-F]{24}$/.test(depositId)) throw new PriorityLineError('INVALID_DEPOSIT', 'Invalid deposit');
    const payoutTxHash = input.payoutTxHash ? String(input.payoutTxHash).trim().toLowerCase() : undefined;
    if (payoutTxHash && !/^0x[0-9a-f]{64}$/.test(payoutTxHash)) {
      throw new PriorityLineError('INVALID_TX_HASH', 'Payout transaction hash is not valid');
    }
    const note = input.note ? String(input.note).trim().slice(0, 512) : undefined;

    const doc = await PriorityLineDeposit.findOneAndUpdate(
      { _id: depositId, status: 'WITHDRAWAL_REQUESTED' },
      {
        $set: {
          status: 'WITHDRAWN',
          withdrawnAt: new Date(),
          processedBy: adminUsername,
          ...(payoutTxHash ? { payoutTxHash } : {}),
          ...(note ? { adminNote: note } : {}),
        },
      },
      { new: true },
    );
    if (!doc) {
      throw new PriorityLineError('NOT_PENDING', 'This withdrawal is not pending (already processed or not requested)', 409);
    }

    logger.info(`Priority Line withdrawal completed: line #${doc.lineNumber} (${doc.walletAddress}) by ${adminUsername}`);
    await NotificationService.createQuiet({
      walletAddress: doc.walletAddress,
      type: 'PRIORITY_LINE_WITHDRAWN',
      title: `Withdrawal completed — line #${doc.lineNumber}`,
      sub: `${fmtUsd(doc.amountUsd)} ${doc.token} has been sent back to you`,
      link: '/priority-line',
      meta: { lineNumber: doc.lineNumber, amountUsd: doc.amountUsd, token: doc.token, payoutTxHash },
      dedupeKey: `PRIORITY_LINE_WITHDRAWN:${doc.id}`,
    });
    return (await PriorityLineService.withUsernames([doc.toObject()]))[0];
  }

  /** Admin declines a withdrawal request; the deposit goes back in line. */
  static async rejectWithdrawal(depositId: string, adminUsername: string, noteRaw: unknown) {
    if (!/^[0-9a-fA-F]{24}$/.test(depositId)) throw new PriorityLineError('INVALID_DEPOSIT', 'Invalid deposit');
    const note = noteRaw ? String(noteRaw).trim().slice(0, 512) : undefined;
    const doc = await PriorityLineDeposit.findOneAndUpdate(
      { _id: depositId, status: 'WITHDRAWAL_REQUESTED' },
      {
        $set: { status: 'ACTIVE', processedBy: adminUsername, ...(note ? { adminNote: note } : {}) },
        $unset: { withdrawalRequestedAt: '' },
      },
      { new: true },
    );
    if (!doc) {
      throw new PriorityLineError('NOT_PENDING', 'This withdrawal is not pending (already processed or not requested)', 409);
    }
    logger.info(`Priority Line withdrawal rejected: line #${doc.lineNumber} (${doc.walletAddress}) by ${adminUsername}`);
    await NotificationService.createQuiet({
      walletAddress: doc.walletAddress,
      type: 'GENERAL',
      title: `Withdrawal request declined — line #${doc.lineNumber}`,
      sub: note || 'Your deposit remains in the Priority Line.',
      link: '/priority-line',
      meta: { lineNumber: doc.lineNumber },
    });
    return (await PriorityLineService.withUsernames([doc.toObject()]))[0];
  }
}
