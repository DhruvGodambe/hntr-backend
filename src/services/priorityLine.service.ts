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

/**
 * The stored `lineNumber` is a permanent ordering ticket (issued by a counter, never reused).
 * What members and admins see as "Line #" is the live position: the rank of that ticket among
 * deposits still in line (ACTIVE or withdrawal pending). When a deposit is withdrawn,
 * everyone behind it moves up, and the next deposit joins at the back of the shortened line.
 */
async function loadQueue(): Promise<number[]> {
  const filter: Record<string, any> = { status: { $in: COUNTED_STATUSES }, lineNumber: { $type: 'number' } };
  const rows = await PriorityLineDeposit.find(filter).select('lineNumber').lean();
  return rows.map((r) => r.lineNumber as number).sort((a, b) => a - b);
}

/** 1-based position of a ticket in the (sorted) queue, or null if it isn't in line. */
function positionOfTicket(queue: number[], ticket: number | null | undefined): number | null {
  if (typeof ticket !== 'number') return null;
  let lo = 0;
  let hi = queue.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (queue[mid] === ticket) return mid + 1;
    if (queue[mid] < ticket) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function dto(d: IPriorityLineDeposit | Record<string, any>, queue: number[]) {
  const inLine = COUNTED_STATUSES.includes(d.status as PriorityLineStatus);
  return {
    id: String(d._id),
    lineNumber: inLine ? positionOfTicket(queue, d.lineNumber) : null,
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
    const [{ tier, cap }, settings, rows, queue] = await Promise.all([
      getCap(wallet),
      getSettingsDoc(),
      PriorityLineDeposit.find({ walletAddress: wallet }).sort({ createdAt: -1 }).lean(),
      loadQueue(),
    ]);
    const counted = rows.filter((r) => COUNTED_STATUSES.includes(r.status));
    const used = roundUsd(counted.reduce((t, r) => t + r.amountUsd, 0));
    const deposits = rows.map((r) => dto(r, queue));
    const positions = deposits.map((d) => d.lineNumber).filter((n): n is number => typeof n === 'number');

    return {
      tier,
      cap,
      used,
      remaining: Math.max(0, roundUsd(cap - used)),
      minDepositUsd: PRIORITY_LINE_MIN_DEPOSIT_USD,
      firstLineNumber: positions.length ? Math.min(...positions) : null,
      depositWallet: settings?.priorityLineDepositWallet || null,
      deposits,
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
          const position = positionOfTicket(await loadQueue(), doc.lineNumber);
          logger.info(`Priority Line deposit ${fmtUsd(amountUsd)} ${token} from ${wallet} → position #${position} (ticket ${doc.lineNumber})`);
          await NotificationService.createQuiet({
            walletAddress: wallet,
            type: 'PRIORITY_LINE_DEPOSIT',
            title: `Priority Line spot reserved — #${position}`,
            sub: `${fmtUsd(amountUsd)} ${token} deposited`,
            link: '/priority-line',
            meta: { lineNumber: position, amountUsd, token, txHash },
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
      const queue = await loadQueue();
      return { deposits: results.map((d) => dto(d, queue)) };
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

    // Still holds its spot until the admin pays, so it still has a position here.
    const queue = await loadQueue();
    const position = positionOfTicket(queue, doc.lineNumber);
    logger.info(`Priority Line withdrawal requested: position #${position} (ticket ${doc.lineNumber}) by ${wallet}`);
    await NotificationService.createQuiet({
      walletAddress: wallet,
      type: 'PRIORITY_LINE_WITHDRAWAL_REQUESTED',
      title: `Withdrawal requested — line #${position}`,
      sub: `${fmtUsd(doc.amountUsd)} ${doc.token} · pending admin review`,
      link: '/priority-line',
      meta: { lineNumber: position, amountUsd: doc.amountUsd, token: doc.token },
      dedupeKey: `PRIORITY_LINE_WITHDRAWAL_REQUESTED:${doc.id}:${doc.withdrawalRequestedAt?.getTime()}`,
    });
    return dto(doc, queue);
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
    const groups: { _id: { token: PriorityToken; status: PriorityLineStatus }; total: number; count: number }[] =
      await PriorityLineDeposit.aggregate([
        { $group: { _id: { token: '$token', status: '$status' }, total: { $sum: '$amountUsd' }, count: { $sum: 1 } } },
      ]);

    const blank = () => ({ inLineUsd: 0, activeDeposits: 0, pendingWithdrawals: 0, pendingWithdrawalsUsd: 0, withdrawnUsd: 0 });
    const byToken: Record<PriorityToken, ReturnType<typeof blank>> = { USDT: blank(), USDC: blank() };
    let reviewDeposits = 0;

    for (const g of groups) {
      const t = byToken[g._id.token];
      if (!t) continue;
      if (COUNTED_STATUSES.includes(g._id.status)) {
        t.inLineUsd += g.total;
        t.activeDeposits += g.count;
      }
      if (g._id.status === 'WITHDRAWAL_REQUESTED') {
        t.pendingWithdrawals += g.count;
        t.pendingWithdrawalsUsd += g.total;
      }
      if (g._id.status === 'WITHDRAWN') t.withdrawnUsd += g.total;
      if (g._id.status === 'REVIEW') reviewDeposits += g.count;
    }
    for (const t of Object.values(byToken)) {
      t.inLineUsd = roundUsd(t.inLineUsd);
      t.pendingWithdrawalsUsd = roundUsd(t.pendingWithdrawalsUsd);
      t.withdrawnUsd = roundUsd(t.withdrawnUsd);
    }

    const all = Object.values(byToken);
    return {
      totalDepositedUsd: roundUsd(all.reduce((s, t) => s + t.inLineUsd, 0)),
      activeDeposits: all.reduce((s, t) => s + t.activeDeposits, 0),
      pendingWithdrawals: all.reduce((s, t) => s + t.pendingWithdrawals, 0),
      pendingWithdrawalsUsd: roundUsd(all.reduce((s, t) => s + t.pendingWithdrawalsUsd, 0)),
      withdrawnUsd: roundUsd(all.reduce((s, t) => s + t.withdrawnUsd, 0)),
      reviewDeposits,
      byToken,
    };
  }

  private static async withUsernames(rows: Record<string, any>[]) {
    const wallets = Array.from(new Set(rows.map((r) => r.walletAddress as string)));
    const [users, queue] = await Promise.all([
      User.find({ walletAddress: { $in: wallets } })
        .select('walletAddress username')
        .lean(),
      loadQueue(),
    ]);
    const names = new Map(users.map((u) => [u.walletAddress, u.username]));
    return rows.map((r) => ({
      ...dto(r, queue),
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
      if (/^#?\d+$/.test(search)) {
        // "#3" means the 3rd position in line now, i.e. the 3rd ticket still in the queue.
        const ticket = (await loadQueue())[Number(search.replace('#', '')) - 1];
        if (ticket !== undefined) or.push({ lineNumber: ticket, status: { $in: COUNTED_STATUSES } });
      }
      filter.$or = or;
    }

    // sort=line is the queue view: position #1 first. Only deposits still in line are shown;
    // withdrawn and REVIEW deposits have no position (unless a specific status is chosen).
    const queue = String(query.sort ?? '') === 'line';
    if (queue) {
      filter.lineNumber = { $type: 'number' };
      if (!filter.status) filter.status = { $in: COUNTED_STATUSES };
    }

    const [rows, total] = await Promise.all([
      PriorityLineDeposit.find(filter)
        .sort(queue ? { lineNumber: 1 } : { createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PriorityLineDeposit.countDocuments(filter),
    ]);
    return paginatedResponse(await PriorityLineService.withUsernames(rows), total, page, limit);
  }

  /**
   * One row per member who has deposited: totals, tier cap and remaining room.
   * sort=amount (default, biggest first) or sort=queue (earliest line number first).
   */
  static async listMembers(query: Record<string, unknown>) {
    const { page, limit, skip } = parsePagination(query);
    const sortQueue = String(query.sort ?? '') === 'queue';

    const match: Record<string, any> = {};
    const search = sanitizeSearch(query.search);
    if (search) {
      const rx = new RegExp(search, 'i');
      const matchedUsers = await User.find({ username: rx }).select('walletAddress').limit(50).lean();
      match.$or = [{ walletAddress: rx }, { walletAddress: { $in: matchedUsers.map((u) => u.walletAddress) } }];
    }

    const counted = { $in: ['$status', COUNTED_STATUSES] };
    const sum = (cond: any) => ({ $sum: { $cond: [cond, '$amountUsd', 0] } });

    const [result] = await PriorityLineDeposit.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$walletAddress',
          inLineUsd: sum(counted),
          pendingWithdrawalUsd: sum({ $eq: ['$status', 'WITHDRAWAL_REQUESTED'] }),
          withdrawnUsd: sum({ $eq: ['$status', 'WITHDRAWN'] }),
          reviewUsd: sum({ $eq: ['$status', 'REVIEW'] }),
          deposits: { $sum: 1 },
          activeDeposits: { $sum: { $cond: [counted, 1, 0] } },
          firstLineNumber: { $min: { $cond: [counted, '$lineNumber', null] } },
          lastDepositAt: { $max: '$createdAt' },
        },
      },
      { $addFields: { noLine: { $cond: [{ $eq: ['$firstLineNumber', null] }, 1, 0] } } },
      {
        $facet: {
          rows: [
            { $sort: sortQueue ? { noLine: 1, firstLineNumber: 1, _id: 1 } : { inLineUsd: -1, _id: 1 } },
            { $skip: skip },
            { $limit: limit },
          ],
          total: [{ $count: 'n' }],
        },
      },
    ]);

    const rows: Record<string, any>[] = result?.rows ?? [];
    const total: number = result?.total?.[0]?.n ?? 0;

    const wallets = rows.map((r) => r._id as string);
    const [users, queue] = await Promise.all([
      User.find({ walletAddress: { $in: wallets } })
        .select('walletAddress username tier')
        .lean(),
      loadQueue(),
    ]);
    const byWallet = new Map(users.map((u) => [u.walletAddress, u]));

    const items = rows.map((r) => {
      const u = byWallet.get(r._id);
      const tier = (u?.tier as Tier | undefined) ?? Tier.NONE;
      const cap = PRIORITY_LINE_TIER_CAPS[tier] ?? 0;
      const inLineUsd = roundUsd(r.inLineUsd);
      return {
        walletAddress: r._id as string,
        username: u?.username ?? null,
        tier,
        cap,
        inLineUsd,
        remainingUsd: Math.max(0, roundUsd(cap - inLineUsd)),
        pendingWithdrawalUsd: roundUsd(r.pendingWithdrawalUsd),
        withdrawnUsd: roundUsd(r.withdrawnUsd),
        reviewUsd: roundUsd(r.reviewUsd),
        deposits: r.deposits as number,
        activeDeposits: r.activeDeposits as number,
        // The aggregate holds the member's lowest ticket; show it as a live position.
        firstLineNumber: positionOfTicket(queue, r.firstLineNumber as number | null),
        lastDepositAt: r.lastDepositAt as Date,
      };
    });
    return paginatedResponse(items, total, page, limit);
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

    // The deposit has left the line, so there is no position to quote; those behind it move up.
    logger.info(`Priority Line withdrawal completed: ticket ${doc.lineNumber} (${doc.walletAddress}) by ${adminUsername}`);
    await NotificationService.createQuiet({
      walletAddress: doc.walletAddress,
      type: 'PRIORITY_LINE_WITHDRAWN',
      title: 'Withdrawal completed',
      sub: `${fmtUsd(doc.amountUsd)} ${doc.token} has been sent back to you`,
      link: '/priority-line',
      meta: { amountUsd: doc.amountUsd, token: doc.token, payoutTxHash },
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
    const position = positionOfTicket(await loadQueue(), doc.lineNumber);
    logger.info(`Priority Line withdrawal rejected: position #${position} (ticket ${doc.lineNumber}, ${doc.walletAddress}) by ${adminUsername}`);
    await NotificationService.createQuiet({
      walletAddress: doc.walletAddress,
      type: 'GENERAL',
      title: `Withdrawal request declined — line #${position}`,
      sub: note || 'Your deposit remains in the Priority Line.',
      link: '/priority-line',
      meta: { lineNumber: position },
    });
    return (await PriorityLineService.withUsernames([doc.toObject()]))[0];
  }
}
