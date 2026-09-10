import { ethers } from 'ethers';
import User from '../models/User';
import Transaction from '../models/Transaction';
import StrategyPool from '../models/StrategyPool';
import AdminUserOverride from '../models/AdminUserOverride';
import AdminSettings from '../models/AdminSettings';
import PointsLedger from '../models/PointsLedger';
import Payout from '../models/Payout';
import AchievementBonus from '../models/AchievementBonus';
import DisbursementBatch from '../models/DisbursementBatch';
import { RewardsService } from './rewards.service';
import { NetworkService } from './network.service';
import { SecurityWalletService } from './securityWallet.service';
import {
  hntrContract,
  hntrContractWithBurnerSigner,
  getErc20,
  getContractAmountDecimals,
  provider,
} from './contract.service';
import { getLogsViaEtherscan } from './etherscan.service';
import { ENV } from '../config/env';
import { LEADERSHIP_ELIGIBLE_RANKS, getLeadershipShares, getRankLadderIndex } from '../constants';
import { paginatedResponse, sanitizeSearch } from '../utils/pagination';
import { normalizeOpenSea, normalizeTags, PoolOpenSeaInput } from './strategyPool.service';
import { logger } from '../utils/logger';
import { runMonthlyLeadershipPayout } from '../jobs/leadership-cron';

export class AdminPanelError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const VALID_RANKS = [
  'None',
  'Scout',
  'Tracker',
  'Ranger',
  'Hunter',
  'Elite Hunter',
  'Master Hunter',
  'Legend Hunter',
] as const;

const VALID_TIERS = ['None', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'] as const;

function getTierLadderIndex(tier: string | null | undefined): number {
  if (!tier || tier === 'None') return -1;
  return VALID_TIERS.indexOf(tier as (typeof VALID_TIERS)[number]);
}

const TX_TYPE_MAP: Record<string, string[]> = {
  all: [],
  commissions: ['COMMISSION_EARNED', 'COMMISSION_CLAIM', 'COMMISSION_WITHDRAWN', 'UNCLAIMED_WITHDRAWN'],
  purchases: ['PURCHASE', 'UPGRADE'],
  gift_redemptions: ['VOUCHER_MEMBERSHIP_REDEEM'],
  membership_overrides: ['MEMBERSHIP_OVERRIDE'],
  withdrawals: ['COMMISSION_WITHDRAWN', 'UNCLAIMED_WITHDRAWN', 'COMMISSION_CLAIM'],
};

const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

function formatMetricUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount === 0) return '$0.00';
  if (Math.abs(amount) >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (Math.abs(amount) >= 1_000) {
    return `$${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }
  return `$${amount.toFixed(2)}`;
}

function padAddressTopic(address: string): string {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

async function readWalletStablecoinBalances(walletAddress: string) {
  const [usdtAddress, usdcAddress, amountDecimals] = await Promise.all([
    hntrContract.usdt(),
    hntrContract.usdc(),
    getContractAmountDecimals(),
  ]);

  const tokens = await Promise.all(
    (
      [
        { symbol: 'USDT' as const, address: usdtAddress },
        { symbol: 'USDC' as const, address: usdcAddress },
      ] as const
    ).map(async ({ symbol, address }) => {
      const erc20 = getErc20(address);
      const rawBalance = await erc20.balanceOf(walletAddress);
      const balance = Number(ethers.formatUnits(rawBalance, amountDecimals));
      return { symbol, balance: Number(balance.toFixed(2)) };
    }),
  );

  const totalUsd = tokens.reduce((sum, t) => sum + t.balance, 0);
  return { tokens, totalUsd: Number(totalUsd.toFixed(2)) };
}

let cachedStablecoinAddresses: { usdt: string; usdc: string } | null = null;

async function getStablecoinAddresses() {
  if (cachedStablecoinAddresses) return cachedStablecoinAddresses;
  const [usdt, usdc] = await Promise.all([hntrContract.usdt(), hntrContract.usdc()]);
  cachedStablecoinAddresses = {
    usdt: String(usdt).toLowerCase(),
    usdc: String(usdc).toLowerCase(),
  };
  return cachedStablecoinAddresses;
}

/** Map stored token address or symbol to USDT/USDC for admin display. */
async function resolveAdminTokenLabel(token?: string | null): Promise<string> {
  if (!token) return '—';
  const raw = String(token).trim();
  if (!raw) return '—';
  const upper = raw.toUpperCase();
  if (upper === 'USDT' || upper === 'USDC') return upper;

  const lower = raw.toLowerCase();
  const { usdt, usdc } = await getStablecoinAddresses();
  if (lower === usdt) return 'USDT';
  if (lower === usdc) return 'USDC';
  if (raw.startsWith('0x') && raw.length >= 10) return `${raw.slice(0, 6)}…${raw.slice(-4)}`;
  return raw;
}

function monthRange(offsetMonths: number) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths + 1, 1));
  return { start, end };
}

function pctChange(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? '+100%' : '0%';
  const pct = ((current - previous) / previous) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(0)}%`;
}

export class AdminPanelService {
  static async getMetrics() {
    const now = new Date();
    const thisMonth = monthRange(0);
    const lastMonth = monthRange(-1);

    const [
      totalUsers,
      soldMemberships,
      volumeAgg,
      lockedVolumeAgg,
      commissionAgg,
      thisMonthUsers,
      lastMonthUsers,
      thisMonthVolume,
      thisMonthLockedVolume,
      lastMonthVolume,
      lastMonthLockedVolume,
      companyAddress,
      leadershipAddress,
      rankAddress,
      poolAddress,
      securityAddress,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ tier: { $ne: 'None' } }),
      Transaction.aggregate([
        { $match: { type: { $in: ['PURCHASE', 'UPGRADE'] }, status: 'CONFIRMED' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: { type: 'COMMISSION_EARNED', status: 'CONFIRMED' } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$lockedAmount', 0] } } } },
      ]),
      Transaction.aggregate([
        { $match: { type: 'COMMISSION_EARNED', status: 'CONFIRMED' } },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                // Prefer liquid+locked so the 20% pool share is never dropped; fall back to amount.
                $max: [
                  {
                    $add: [{ $ifNull: ['$liquidAmount', 0] }, { $ifNull: ['$lockedAmount', 0] }],
                  },
                  { $ifNull: ['$amount', 0] },
                ],
              },
            },
          },
        },
      ]),
      User.countDocuments({ joinedAt: { $gte: thisMonth.start, $lt: thisMonth.end } }),
      User.countDocuments({ joinedAt: { $gte: lastMonth.start, $lt: lastMonth.end } }),
      Transaction.aggregate([
        {
          $match: {
            type: { $in: ['PURCHASE', 'UPGRADE'] },
            status: 'CONFIRMED',
            timestamp: { $gte: thisMonth.start, $lt: thisMonth.end },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        {
          $match: {
            type: 'COMMISSION_EARNED',
            status: 'CONFIRMED',
            timestamp: { $gte: thisMonth.start, $lt: thisMonth.end },
          },
        },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$lockedAmount', 0] } } } },
      ]),
      Transaction.aggregate([
        {
          $match: {
            type: { $in: ['PURCHASE', 'UPGRADE'] },
            status: 'CONFIRMED',
            timestamp: { $gte: lastMonth.start, $lt: lastMonth.end },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        {
          $match: {
            type: 'COMMISSION_EARNED',
            status: 'CONFIRMED',
            timestamp: { $gte: lastMonth.start, $lt: lastMonth.end },
          },
        },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$lockedAmount', 0] } } } },
      ]),
      hntrContract.companyWallet(),
      hntrContract.leadershipWallet(),
      hntrContract.rankWallet(),
      hntrContract.poolWallet(),
      hntrContract.securityWallet(),
    ]);

    // Membership spend + locked commission share (liquid commissions stay under Total Commissions).
    const totalVolume = (volumeAgg[0]?.total ?? 0) + (lockedVolumeAgg[0]?.total ?? 0);
    const totalCommissions = commissionAgg[0]?.total ?? 0;
    const thisMonthVol = (thisMonthVolume[0]?.total ?? 0) + (thisMonthLockedVolume[0]?.total ?? 0);
    const lastMonthVol = (lastMonthVolume[0]?.total ?? 0) + (lastMonthLockedVolume[0]?.total ?? 0);

    const [companyBal, leadershipBal, rankBal, poolBal, securityBal] = await Promise.all([
      readWalletStablecoinBalances(String(companyAddress)),
      readWalletStablecoinBalances(String(leadershipAddress)),
      readWalletStablecoinBalances(String(rankAddress)),
      readWalletStablecoinBalances(String(poolAddress)),
      readWalletStablecoinBalances(String(securityAddress)),
    ]);

    const commissionPct =
      totalVolume > 0 ? `${Math.round((totalCommissions / totalVolume) * 100)}% distribution` : '0% distribution';

    const companyTotal = companyBal.totalUsd;
    const companyCutPct =
      totalVolume > 0 ? `${Math.round((companyTotal / totalVolume) * 100)}% company cut` : '25% company cut';

    return {
      totalUsers,
      totalVolume,
      totalCommissions,
      companyBalance: companyTotal,
      soldMemberships,
      activePools: await StrategyPool.countDocuments({ status: 'OPEN' }),
      pendingWithdrawals: 0,
      trends: {
        usersThisMonth: thisMonthUsers,
        usersChange: pctChange(thisMonthUsers, lastMonthUsers),
        volumeThisMonth: thisMonthVol,
        volumeChange: pctChange(thisMonthVol, lastMonthVol),
      },
      cards: [
        { title: 'Total Users', value: totalUsers, subValue: `${pctChange(thisMonthUsers, lastMonthUsers)} this month` },
        {
          title: 'Total Volume',
          value: formatMetricUsd(totalVolume),
          subValue: `${pctChange(thisMonthVol, lastMonthVol)} this month`,
        },
        {
          title: 'Total Commissions',
          value: formatMetricUsd(totalCommissions),
          subValue: commissionPct,
        },
        {
          title: 'Company Balance',
          value: formatMetricUsd(companyTotal),
          subValue: companyCutPct,
        },
        { title: 'Sold Memberships', value: soldMemberships, subValue: 'All tiers' },
      ],
      walletSummary: {
        company: { address: String(companyAddress).toLowerCase(), ...companyBal },
        leadership: { address: String(leadershipAddress).toLowerCase(), ...leadershipBal },
        rank: { address: String(rankAddress).toLowerCase(), ...rankBal },
        pool: { address: String(poolAddress).toLowerCase(), ...poolBal },
        security: { address: String(securityAddress).toLowerCase(), ...securityBal },
      },
    };
  }

  static async getRecentActivity(page: number, limit: number, skip: number) {
    const filter = {
      type: {
        $in: [
          'PURCHASE',
          'UPGRADE',
          'VOUCHER_MEMBERSHIP_REDEEM',
          'MEMBERSHIP_OVERRIDE',
          'COMMISSION_EARNED',
          'COMMISSION_WITHDRAWN',
          'UNCLAIMED_WITHDRAWN',
        ] as const,
      },
      status: 'CONFIRMED' as const,
    };

    const [total, rows] = await Promise.all([
      Transaction.countDocuments(filter as any),
      Transaction.find(filter as any).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
    ]);

    const walletAddresses = [...new Set(rows.map((r) => r.walletAddress.toLowerCase()))];
    const users = await User.find({ walletAddress: { $in: walletAddresses } })
      .select('walletAddress username')
      .lean();
    const userByWallet = new Map(users.map((u) => [u.walletAddress.toLowerCase(), u.username]));

    const items = await Promise.all(
      rows.map(async (tx) => ({
      id: String(tx._id),
      type:
        tx.type === 'COMMISSION_EARNED'
          ? 'Commission Earned'
          : tx.type === 'PURCHASE'
            ? 'Membership Purchase'
            : tx.type === 'UPGRADE'
              ? 'Membership Upgrade'
              : tx.type === 'VOUCHER_MEMBERSHIP_REDEEM'
                ? 'Gift Redemption'
                : tx.type === 'MEMBERSHIP_OVERRIDE'
                  ? 'Membership Override'
                  : tx.type === 'UNCLAIMED_WITHDRAWN'
                    ? 'Admin Withdrawal'
                    : 'Withdrawal',
      user: userByWallet.get(tx.walletAddress.toLowerCase()) || tx.walletAddress.slice(0, 6) + '...',
      walletAddress: tx.walletAddress,
      amount: tx.amount,
      token: await resolveAdminTokenLabel(tx.token),
      status: tx.status,
      timestamp: tx.timestamp,
    })),
    );

    return paginatedResponse(items, total, page, limit);
  }

  static async getUsers(search: string, page: number, limit: number, skip: number, statusFilter?: string) {
    const query: Record<string, unknown> = {};

    if (search) {
      const safe = sanitizeSearch(search);
      if (safe) {
        query.$or = [
          { username: { $regex: safe, $options: 'i' } },
          { walletAddress: { $regex: safe, $options: 'i' } },
          { email: { $regex: safe, $options: 'i' } },
        ];
      }
    }

    const [total, users] = await Promise.all([
      User.countDocuments(query),
      User.find(query).sort({ joinedAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    const usernames = users.map((u) => u.username);
    const overrides = await AdminUserOverride.find({ username: { $in: usernames.map((u) => u.toLowerCase()) } }).lean();
    const overrideByUser = new Map(overrides.map((o) => [o.username, o]));

    const downlineCounts = await Promise.all(
      users.map(async (u) => User.countDocuments({ ancestors: u.username })),
    );

    let items = users.map((u, idx) => {
      const override = overrideByUser.get(u.username.toLowerCase());
      const isBlocked = override?.isBlocked ?? false;
      // Membership tier is on-chain truth stored on User; tierOverride tracks free force.
      const tier = u.tier;
      // Rank may be force-upgraded by admin.
      const rank = override?.rankOverride || u.rank;

      return {
        id: String(u._id),
        username: u.username,
        walletAddress: u.walletAddress,
        tier,
        rank,
        teamVolume: u.teamVolume,
        directs: u.directDownline?.length ?? 0,
        downlines: downlineCounts[idx],
        status: isBlocked ? 'Blocked' : 'Active',
        isBlocked,
        isForcedRank: Boolean(u.isForcedRank) || Boolean(override?.rankOverride),
        isForcedMembership: Boolean(u.isForcedMembership) || Boolean(override?.tierOverride),
        // A gift-code redemption reuses the forced-membership lifecycle internally
        // (see User.isVoucherMembership doc comment) but is not an admin override —
        // the UI uses this to show "Gift" instead of "Forced" for those accounts.
        isVoucherMembership: Boolean(u.isVoucherMembership),
        joinedAt: u.joinedAt,
        actualTier: u.tier,
        actualRank: u.rank,
        tierOverride: override?.tierOverride ?? null,
        rankOverride: override?.rankOverride ?? null,
      };
    });

    if (statusFilter === 'blocked') {
      items = items.filter((u) => u.isBlocked);
    } else if (statusFilter === 'active') {
      items = items.filter((u) => !u.isBlocked);
    }

    return paginatedResponse(items, statusFilter ? items.length : total, page, limit);
  }

  static async setUserBlocked(username: string, blocked: boolean, reason?: string) {
    const user = await User.findOne({ username });
    if (!user) throw new AdminPanelError('USER_NOT_FOUND', 'User not found.', 404);

    const override = await AdminUserOverride.findOneAndUpdate(
      { username: username.toLowerCase() },
      { isBlocked: blocked, blockedReason: blocked ? reason : undefined },
      { upsert: true, new: true },
    );

    return {
      username: user.username,
      isBlocked: override.isBlocked,
      message: blocked ? 'User blocked successfully.' : 'User unblocked successfully.',
    };
  }

  /**
   * Admin may only force-upgrade network rank (not membership tier).
   * Membership is purchased/upgraded on-chain only; admin cannot change it.
   */
  static async overrideUserProfile(username: string, tier?: string, rank?: string) {
    const user = await User.findOne({ username });
    if (!user) throw new AdminPanelError('USER_NOT_FOUND', 'User not found.', 404);

    if (tier !== undefined && tier !== null && String(tier).length > 0) {
      throw new AdminPanelError(
        'MEMBERSHIP_IMMUTABLE',
        'Membership tier cannot be changed from admin. Users purchase or upgrade on-chain only.',
        400,
      );
    }

    if (rank === undefined || rank === null || String(rank).length === 0) {
      throw new AdminPanelError('RANK_REQUIRED', 'Rank is required for profile override.', 400);
    }

    if (!VALID_RANKS.includes(rank as (typeof VALID_RANKS)[number])) {
      throw new AdminPanelError('INVALID_RANK', `Invalid rank. Allowed: ${VALID_RANKS.join(', ')}`);
    }

    const previousRank = user.rank;
    const previousTier = user.tier;
    const nextRank = rank;

    const prevIdx = getRankLadderIndex(previousRank);
    const nextIdx = getRankLadderIndex(nextRank);
    if (nextIdx < prevIdx) {
      throw new AdminPanelError(
        'RANK_DOWNGRADE',
        `Cannot rank down (${previousRank} → ${nextRank}). Admin may only upgrade rank.`,
        400,
      );
    }
    if (nextIdx === prevIdx) {
      const ov = await AdminUserOverride.findOne({ username: username.toLowerCase() }).lean();
      return {
        username: user.username,
        tier: user.tier,
        rank: user.rank,
        isForcedRank: Boolean(user.isForcedRank),
        isForcedMembership: Boolean(user.isForcedMembership),
        previousRank,
        previousTier,
        tierOverride: ov?.tierOverride ?? null,
        rankOverride: ov?.rankOverride ?? null,
        message: 'Rank unchanged.',
      };
    }

    // Rank only for this endpoint — membership free force goes through company-wallet
    // overrideMembershipTier + recordMembershipOverride.
    user.rank = nextRank as typeof user.rank;
    user.isForcedRank = true;
    if (user.walletAddress) {
      try {
        const onChainUser = await hntrContract.getUser(user.walletAddress);
        const tierNames = ['None', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'] as const;
        const onChainTier = tierNames[Number(onChainUser[0] ?? onChainUser.tier)] || 'None';
        if (user.tier !== onChainTier) {
          logger.info(
            `Repairing ${username} membership from Mongo ${user.tier} → on-chain ${onChainTier}`,
          );
          user.tier = onChainTier as typeof user.tier;
        }
      } catch (err: unknown) {
        logger.warn(
          `Could not re-sync on-chain tier for ${username}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    await user.save();

    const existingOverride = await AdminUserOverride.findOne({
      username: username.toLowerCase(),
    }).lean();

    const override = await AdminUserOverride.findOneAndUpdate(
      { username: username.toLowerCase() },
      {
        $set: {
          rankOverride: nextRank,
          // Preserve existing membership force tracking if present.
          tierOverride: existingOverride?.tierOverride ?? null,
        },
      },
      { upsert: true, new: true },
    );

    try {
      const { NotificationService } = await import('./notification.service');
      const shares = getLeadershipShares(nextRank);
      await NotificationService.createQuiet({
        walletAddress: user.walletAddress,
        type: 'RANK_UP',
        title: `Rank upgraded to ${nextRank}`,
        sub:
          shares > 0
            ? `You now have ${shares} leadership share${shares === 1 ? '' : 's'} in the monthly pool. Achievement bonuses unlock as your team volume qualifies.`
            : `Keep growing — Hunter rank and above unlock leadership pool shares. Achievement bonuses unlock as your team volume qualifies.`,
        link: 'VIEW NETWORK',
        meta: {
          previousRank,
          newRank: nextRank,
          shares,
          source: 'admin_override',
          isForcedRank: true,
        },
      });
    } catch (err: unknown) {
      logger.error(
        `Failed to notify rank override for ${username}: ${err instanceof Error ? err.message : err}`,
      );
    }

    return {
      username: user.username,
      tier: user.tier,
      rank: user.rank,
      isForcedRank: Boolean(user.isForcedRank),
      isForcedMembership: Boolean(user.isForcedMembership),
      previousRank,
      previousTier,
      tierOverride: override.tierOverride ?? null,
      rankOverride: override.rankOverride ?? null,
      message: `Rank upgraded to ${nextRank}. Membership is unchanged (${user.tier}).`,
    };
  }

  /**
   * After company wallet submits overrideMembershipTier on-chain, persist Mongo
   * tier + forced-membership flags. Does not invent volume or purchase events.
   */
  static async recordMembershipOverride(params: {
    username: string;
    txHash: string;
    tier: string;
  }) {
    const { username, txHash, tier } = params;
    if (!txHash || !ethers.isHexString(txHash, 32)) {
      throw new AdminPanelError('INVALID_TX', 'Valid txHash is required.', 400);
    }
    if (!VALID_TIERS.includes(tier as (typeof VALID_TIERS)[number]) || tier === 'None') {
      throw new AdminPanelError(
        'INVALID_TIER',
        `Invalid tier. Allowed: ${VALID_TIERS.filter((t) => t !== 'None').join(', ')}`,
        400,
      );
    }

    const user = await User.findOne({ username });
    if (!user) throw new AdminPanelError('USER_NOT_FOUND', 'User not found.', 404);
    if (!user.walletAddress) {
      throw new AdminPanelError('NO_WALLET', 'User has no wallet address.', 400);
    }

    const wallet = user.walletAddress.toLowerCase();
    const previousTier = user.tier;
    const requestedIdx = getTierLadderIndex(tier);

    const onChainUser = await hntrContract.getUser(wallet);
    const onChainTierIdx = Number(onChainUser[0] ?? onChainUser.tier);
    const onChainTier =
      VALID_TIERS[onChainTierIdx] && onChainTierIdx >= 0 ? VALID_TIERS[onChainTierIdx] : 'None';

    if (getTierLadderIndex(onChainTier) < requestedIdx) {
      throw new AdminPanelError(
        'CHAIN_TIER_MISMATCH',
        `On-chain tier is ${onChainTier}, expected at least ${tier}. Wait for the tx to confirm or check the company wallet call.`,
        400,
      );
    }
    // Accept equal or higher (if delayed check already advanced).
    if (getTierLadderIndex(onChainTier) < getTierLadderIndex(previousTier)) {
      throw new AdminPanelError(
        'TIER_DOWNGRADE',
        `On-chain tier ${onChainTier} is below previous membership ${previousTier}.`,
        400,
      );
    }

    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) {
        if (receipt.to && receipt.to.toLowerCase() !== ENV.CONTRACT_ADDRESS.toLowerCase()) {
          throw new AdminPanelError(
            'WRONG_CONTRACT',
            'Transaction was not sent to the membership contract.',
            400,
          );
        }
      }
    } catch (err: unknown) {
      if (err instanceof AdminPanelError) throw err;
      logger.warn(
        `Could not fully verify membership override receipt ${txHash}: ${err instanceof Error ? err.message : err}`,
      );
    }

    user.tier = onChainTier as typeof user.tier;
    user.isForcedMembership = true;
    await user.save();

    const override = await AdminUserOverride.findOneAndUpdate(
      { username: username.toLowerCase() },
      { $set: { tierOverride: onChainTier } },
      { upsert: true, new: true },
    );

    logger.info(
      `Recorded membership override for ${username}: ${previousTier} -> ${onChainTier} (forced, tx=${txHash})`,
    );

    return {
      username: user.username,
      walletAddress: user.walletAddress,
      tier: user.tier,
      rank: user.rank,
      isForcedMembership: true,
      isForcedRank: Boolean(user.isForcedRank),
      previousTier,
      tierOverride: override.tierOverride ?? onChainTier,
      rankOverride: override.rankOverride ?? null,
      txHash: txHash.toLowerCase(),
      message: `Membership set to ${onChainTier} (company free override).`,
    };
  }

  /**
   * Executes `overrideMembershipTier` on-chain using the backend burner-wallet
   * signer, then persists the Mongo tier + forced-membership flags via
   * recordMembershipOverride. Lets the admin panel force a tier without connecting
   * a wallet in the browser. Requires BURNER_WALLET_PRIVATE_KEY.
   */
  static async executeMembershipOverride(params: { username: string; tier: string }) {
    const { username, tier } = params;

    if (!VALID_TIERS.includes(tier as (typeof VALID_TIERS)[number]) || tier === 'None') {
      throw new AdminPanelError(
        'INVALID_TIER',
        `Invalid tier. Allowed: ${VALID_TIERS.filter((t) => t !== 'None').join(', ')}`,
        400,
      );
    }

    if (!hntrContractWithBurnerSigner) {
      throw new AdminPanelError(
        'BURNER_SIGNER_NOT_CONFIGURED',
        'BURNER_WALLET_PRIVATE_KEY is not configured in the backend.',
        503,
      );
    }

    const user = await User.findOne({ username });
    if (!user) throw new AdminPanelError('USER_NOT_FOUND', 'User not found.', 404);
    if (!user.walletAddress) {
      throw new AdminPanelError('NO_WALLET', 'User has no wallet address.', 400);
    }

    const wallet = user.walletAddress.toLowerCase();
    const requestedIdx = getTierLadderIndex(tier);

    const onChainUser = await hntrContract.getUser(wallet);
    const onChainTierIdx = Number(onChainUser[0] ?? onChainUser.tier);
    if (requestedIdx <= onChainTierIdx) {
      throw new AdminPanelError(
        'INVALID_UPGRADE',
        `On-chain tier is already ${VALID_TIERS[onChainTierIdx] || 'None'}. Can only force a strictly higher tier.`,
        400,
      );
    }

    const tx = await (hntrContractWithBurnerSigner as any).overrideMembershipTier(wallet, requestedIdx);
    logger.info(`Membership override submitted for ${username} (${wallet}) -> ${tier}: ${tx.hash}`);
    await tx.wait();

    return this.recordMembershipOverride({ username, txHash: tx.hash as string, tier });
  }

  static async getTransactions(type: string, page: number, limit: number, skip: number, search?: string) {
    const query: Record<string, unknown> = { status: { $in: ['CONFIRMED', 'PENDING', 'FAILED'] } };

    const mappedTypes = TX_TYPE_MAP[type] ?? TX_TYPE_MAP.all;
    if (mappedTypes.length > 0) query.type = { $in: mappedTypes };

    if (search) {
      const safe = sanitizeSearch(search);
      if (safe) {
        query.$or = [
          { walletAddress: { $regex: safe, $options: 'i' } },
          { txHash: { $regex: safe, $options: 'i' } },
        ];
      }
    }

    const [total, rows] = await Promise.all([
      Transaction.countDocuments(query),
      Transaction.find(query).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
    ]);

    const walletAddresses = [...new Set(rows.map((r) => r.walletAddress.toLowerCase()))];
    const [users, pointsLedgers] = await Promise.all([
      User.find({ walletAddress: { $in: walletAddresses } }).select('walletAddress username hntrPoints').lean(),
      PointsLedger.find({ walletAddress: { $in: walletAddresses } })
        .sort({ timestamp: -1 })
        .lean(),
    ]);

    const userByWallet = new Map(users.map((u) => [u.walletAddress.toLowerCase(), u]));

    const items = await Promise.all(
      rows.map(async (tx) => {
      const user = userByWallet.get(tx.walletAddress.toLowerCase());
      const relatedPoints = pointsLedgers.find(
        (p) =>
          p.walletAddress.toLowerCase() === tx.walletAddress.toLowerCase() &&
          tx.txHash &&
          p.txHash === tx.txHash,
      );

      return {
        id: String(tx._id),
        date: tx.timestamp,
        user: user?.username || tx.walletAddress.slice(0, 8) + '...',
        walletAddress: tx.walletAddress,
        type: tx.type,
        amount: tx.amount,
        token: await resolveAdminTokenLabel(tx.token),
        hntrPoints: relatedPoints?.amount ?? null,
        txHash: tx.txHash || null,
        status: tx.status,
        tier: tx.tier,
        level: tx.level,
      };
    }),
    );

    return paginatedResponse(items, total, page, limit);
  }

  static async getWalletBalances() {
    const [company, leadership, rank, pool, security] = await Promise.all([
      hntrContract.companyWallet(),
      hntrContract.leadershipWallet(),
      hntrContract.rankWallet(),
      hntrContract.poolWallet(),
      hntrContract.securityWallet(),
    ]);

    const wallets = [
      { name: 'Company Wallet', key: 'company', address: String(company) },
      { name: 'Leadership Wallet', key: 'leadership', address: String(leadership) },
      { name: 'Rank Wallet', key: 'rank', address: String(rank) },
      { name: 'Pool Wallet', key: 'pool', address: String(pool) },
      { name: 'Security Wallet', key: 'security', address: String(security) },
    ];

    const items = await Promise.all(
      wallets.map(async (w) => {
        const balances = await readWalletStablecoinBalances(w.address);
        const primary = balances.tokens.find((t) => t.balance > 0) || balances.tokens[0];
        return {
          name: w.name,
          key: w.key,
          symbol: primary?.symbol || 'USDT',
          balance: balances.totalUsd,
          tokens: balances.tokens,
          address: w.address.toLowerCase(),
        };
      }),
    );

    return items;
  }

  static async getWalletLedger(walletKey: string, page: number, limit: number, skip: number) {
    const validKeys = ['company', 'leadership', 'rank', 'pool', 'security'] as const;
    if (!validKeys.includes(walletKey as (typeof validKeys)[number])) {
      throw new AdminPanelError('INVALID_WALLET', 'Unknown wallet key.');
    }

    const addressMap: Record<(typeof validKeys)[number], () => Promise<string>> = {
      company: () => hntrContract.companyWallet(),
      leadership: () => hntrContract.leadershipWallet(),
      rank: () => hntrContract.rankWallet(),
      pool: () => hntrContract.poolWallet(),
      security: () => hntrContract.securityWallet(),
    };

    const walletAddress = ethers.getAddress(String(await addressMap[walletKey as (typeof validKeys)[number]]()));
    // Scan wallet ledgers from the current membership contract's deployment block
    // so a fresh redeploy shows only that contract's activity. LEDGER_FROM_BLOCK,
    // when set, overrides this to reach further back (e.g. to include prior-contract
    // history for protocol wallets that persist across cutovers).
    const fromBlock = Math.max(0, ENV.LEDGER_FROM_BLOCK || ENV.CONTRACT_DEPLOY_BLOCK || 0);
    const [usdtAddress, usdcAddress, amountDecimals] = await Promise.all([
      hntrContract.usdt(),
      hntrContract.usdc(),
      getContractAmountDecimals(),
    ]);

    const tokenMeta = [
      { symbol: 'USDT', address: String(usdtAddress) },
      { symbol: 'USDC', address: String(usdcAddress) },
    ];

    const paddedWallet = padAddressTopic(walletAddress);

    type LedgerRow = {
      id: string;
      direction: 'IN' | 'OUT';
      type: string;
      amount: number;
      token: string;
      counterparty: string;
      timestamp: string;
      txHash: string;
      blockNumber: number;
    };

    const rows: LedgerRow[] = [];

    for (const token of tokenMeta) {
      try {
        const [inLogs, outLogs] = await Promise.all([
          getLogsViaEtherscan({
            address: token.address,
            topics: [ERC20_TRANSFER_TOPIC, undefined, paddedWallet],
            fromBlock,
          }),
          getLogsViaEtherscan({
            address: token.address,
            topics: [ERC20_TRANSFER_TOPIC, paddedWallet, undefined],
            fromBlock,
          }),
        ]);

        for (const log of inLogs) {
          const amount = Number(ethers.formatUnits(BigInt(log.data || '0x0'), amountDecimals));
          const from = log.topics[1] ? ethers.getAddress(`0x${log.topics[1].slice(26)}`) : ethers.ZeroAddress;
          rows.push({
            id: `${log.transactionHash}-${log.logIndex}-in`,
            direction: 'IN',
            type: 'Transfer In',
            amount: Number(amount.toFixed(6)),
            token: token.symbol,
            counterparty: from.toLowerCase(),
            timestamp: new Date((log.timeStamp || 0) * 1000).toISOString(),
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
          });
        }

        for (const log of outLogs) {
          const amount = Number(ethers.formatUnits(BigInt(log.data || '0x0'), amountDecimals));
          const to = log.topics[2] ? ethers.getAddress(`0x${log.topics[2].slice(26)}`) : ethers.ZeroAddress;
          rows.push({
            id: `${log.transactionHash}-${log.logIndex}-out`,
            direction: 'OUT',
            type: 'Transfer Out',
            amount: Number(amount.toFixed(6)),
            token: token.symbol,
            counterparty: to.toLowerCase(),
            timestamp: new Date((log.timeStamp || 0) * 1000).toISOString(),
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
          });
        }
      } catch (err: any) {
        logger.warn(`Failed fetching ${token.symbol} transfers for ${walletKey}: ${err.message}`);
      }
    }

    // Fallback for pool wallet: also surface locked commission accruals from DB
    // when Etherscan has no token-transfer history yet.
    if (walletKey === 'pool' && rows.length === 0) {
      const [total, dbRows] = await Promise.all([
        Transaction.countDocuments({ lockedAmount: { $gt: 0 }, status: 'CONFIRMED' }),
        Transaction.find({ lockedAmount: { $gt: 0 }, status: 'CONFIRMED' })
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
      ]);
      const items = await Promise.all(
        dbRows.map(async (tx) => ({
        id: String(tx._id),
        direction: 'IN' as const,
        type: 'Locked Commission',
        amount: tx.lockedAmount || 0,
        token: await resolveAdminTokenLabel(tx.token),
        counterparty: tx.walletAddress,
        timestamp: new Date(tx.timestamp).toISOString(),
        txHash: tx.txHash || '',
        blockNumber: 0,
      })),
      );
      return {
        walletKey,
        walletAddress: walletAddress.toLowerCase(),
        source: 'database',
        totals: {
          inflow: items.reduce((s, i) => s + i.amount, 0),
          outflow: 0,
        },
        ...paginatedResponse(items, total, page, limit),
      };
    }

    rows.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      if (tb !== ta) return tb - ta;
      return b.blockNumber - a.blockNumber;
    });

    const inflow = rows.filter((r) => r.direction === 'IN').reduce((s, r) => s + r.amount, 0);
    const outflow = rows.filter((r) => r.direction === 'OUT').reduce((s, r) => s + r.amount, 0);
    const pageItems = rows.slice(skip, skip + limit);

    return {
      walletKey,
      walletAddress: walletAddress.toLowerCase(),
      source: 'blockchain',
      totals: {
        inflow: Number(inflow.toFixed(2)),
        outflow: Number(outflow.toFixed(2)),
      },
      ...paginatedResponse(pageItems, rows.length, page, limit),
    };
  }

  static async getLeadershipPreview() {
    const leadershipWallet = await hntrContract.leadershipWallet();
    const balances = await readWalletStablecoinBalances(String(leadershipWallet));
    const health = await RewardsService.getDisbursementWalletHealth(String(leadershipWallet));

    const eligibleUsers = await User.find({ rank: { $in: [...LEADERSHIP_ELIGIBLE_RANKS] } })
      .select('username rank walletAddress')
      .lean();

    const month = new Date().toISOString().slice(0, 7);
    const paidUsernames = new Set(
      (
        await Payout.find({ month, status: 'PAID' }).select('username').lean()
      ).map((p) => p.username),
    );

    let totalShares = 0;
    const hunters = eligibleUsers
      .map((u) => {
        const shares = getLeadershipShares(u.rank);
        totalShares += shares;
        return {
          username: u.username,
          rank: u.rank,
          shares,
          walletAddress: u.walletAddress,
          alreadyPaid: paidUsernames.has(u.username),
        };
      })
      .sort((a, b) => b.shares - a.shares);

    const unpaidShares = hunters.filter((h) => !h.alreadyPaid).reduce((s, h) => s + h.shares, 0);
    const withEstimates = hunters.map((h) => ({
      ...h,
      estimatedPayoutUSD:
        !h.alreadyPaid && unpaidShares > 0
          ? Number(((balances.totalUsd * h.shares) / unpaidShares).toFixed(2))
          : h.alreadyPaid
            ? 0
            : totalShares > 0
              ? Number(((balances.totalUsd * h.shares) / totalShares).toFixed(2))
              : 0,
    }));

    const lastBatch = await DisbursementBatch.findOne({ type: 'LEADERSHIP', month })
      .sort({ createdAt: -1 })
      .lean();

    const fundTotals = {
      USDT: health.protocolTokens.find((t) => t.symbol === 'USDT')?.balance ?? 0,
      USDC: health.protocolTokens.find((t) => t.symbol === 'USDC')?.balance ?? 0,
    };
    const burnerHas = {
      USDT: health.burnerTokens.find((t) => t.symbol === 'USDT')?.balance ?? 0,
      USDC: health.burnerTokens.find((t) => t.symbol === 'USDC')?.balance ?? 0,
    };
    // The whole leadership pool is distributed. Move USDT first, then USDC for the
    // rest — only top up what the burner is missing.
    const fundToBurner = {
      USDT: Math.max(0, Number((fundTotals.USDT - burnerHas.USDT).toFixed(6))),
      USDC: Math.max(0, Number((fundTotals.USDC - burnerHas.USDC).toFixed(6))),
    };

    return {
      poolBalanceUSD: balances.totalUsd,
      poolTokens: balances.tokens,
      leadershipWallet: String(leadershipWallet).toLowerCase(),
      eligibleCount: eligibleUsers.length,
      unpaidCount: hunters.filter((h) => !h.alreadyPaid).length,
      eligibleUsers: withEstimates,
      totalShares,
      month,
      fundTotals,
      burnerHas,
      fundToBurner,
      fundFromWallet: String(leadershipWallet).toLowerCase(),
      hopNote: health.hopNote,
      protocolEth: health.protocolEth,
      burnerEth: health.burnerEth,
      burnerMinEth: health.burnerMinEth,
      burnerWallet: health.burnerWallet,
      burnerTokens: health.burnerTokens,
      lastBatch: lastBatch
        ? {
            id: String(lastBatch._id),
            status: lastBatch.status,
            triggeredBy: lastBatch.triggeredBy,
            createdAt: lastBatch.createdAt,
            fundTransfers: lastBatch.fundTransfers,
            error: lastBatch.error,
          }
        : null,
    };
  }

  static async getAchievementPreview() {
    const rankWallet = await hntrContract.rankWallet();
    const balances = await readWalletStablecoinBalances(String(rankWallet));
    const health = await RewardsService.getDisbursementWalletHealth(String(rankWallet));

    const pending = await AchievementBonus.find({ status: 'PENDING' })
      .sort({ createdAt: 1 })
      .lean();
    const pendingReviewCount = await AchievementBonus.countDocuments({ status: 'PENDING_REVIEW' });
    const totalPendingUSD = pending.reduce((sum, b) => sum + (b.amountUSD || 0), 0);

    const lastBatch = await DisbursementBatch.findOne({ type: { $in: ['RANK', 'ACHIEVEMENT'] } })
      .sort({ createdAt: -1 })
      .lean();

    const rankHas = {
      USDT: health.protocolTokens.find((t) => t.symbol === 'USDT')?.balance ?? 0,
      USDC: health.protocolTokens.find((t) => t.symbol === 'USDC')?.balance ?? 0,
    };
    const burnerHas = {
      USDT: health.burnerTokens.find((t) => t.symbol === 'USDT')?.balance ?? 0,
      USDC: health.burnerTokens.find((t) => t.symbol === 'USDC')?.balance ?? 0,
    };
    // Burner needs `totalPendingUSD`. Cover the shortfall from the rank wallet —
    // USDT first, then USDC for whatever USDT can't cover.
    const need = Math.max(0, Number((totalPendingUSD - burnerHas.USDT - burnerHas.USDC).toFixed(6)));
    const fundUsdt = Math.min(need, rankHas.USDT);
    const fundUsdc = Math.max(0, Number((need - fundUsdt).toFixed(6)));
    const fundToBurner = { USDT: Number(fundUsdt.toFixed(6)), USDC: fundUsdc };

    return {
      poolBalanceUSD: balances.totalUsd,
      poolTokens: balances.tokens,
      rankWallet: String(rankWallet).toLowerCase(),
      pendingCount: pending.length,
      pendingReviewCount,
      totalPendingUSD: Number(totalPendingUSD.toFixed(2)),
      burnerHas,
      fundToBurner,
      fundFromWallet: String(rankWallet).toLowerCase(),
      pendingBonuses: pending.map((b) => ({
        id: String(b._id),
        username: b.username,
        walletAddress: b.walletAddress,
        rank: b.rank,
        amountUSD: b.amountUSD,
        createdAt: b.createdAt,
      })),
      hopNote: health.hopNote,
      protocolEth: health.protocolEth,
      burnerEth: health.burnerEth,
      burnerMinEth: health.burnerMinEth,
      burnerWallet: health.burnerWallet,
      burnerTokens: health.burnerTokens,
      lastBatch: lastBatch
        ? {
            id: String(lastBatch._id),
            status: lastBatch.status,
            triggeredBy: lastBatch.triggeredBy,
            createdAt: lastBatch.createdAt,
            fundTransfers: lastBatch.fundTransfers,
            error: lastBatch.error,
          }
        : null,
    };
  }

  static async distributeLeadership(triggeredBy = 'admin') {
    return runMonthlyLeadershipPayout(triggeredBy);
  }

  static async distributeAchievement(triggeredBy = 'admin') {
    const payouts = await RewardsService.disbursePendingAchievementBonuses(triggeredBy);
    return { payouts, paid: payouts.length };
  }

  static async listRecentDisbursements(limit = 20) {
    const items = await DisbursementBatch.find()
      .sort({ createdAt: -1 })
      .limit(Math.min(100, Math.max(1, limit)))
      .lean();
    return items.map((b) => ({
      id: String(b._id),
      type: b.type,
      month: b.month,
      status: b.status,
      triggeredBy: b.triggeredBy,
      protocolWallet: b.protocolWallet,
      burnerWallet: b.burnerWallet,
      fundTransfers: b.fundTransfers,
      dispersalCount: b.dispersals?.length || 0,
      error: b.error,
      createdAt: b.createdAt,
    }));
  }

  static async getRankBonusReport(page: number, limit: number, skip: number) {
    const report = await RewardsService.generateRankBonusReport();
    const total = report.length;
    const items = report.slice(skip, skip + limit);
    return paginatedResponse(items, total, page, limit);
  }

  static async getOverdueCommissions(token = 'USDT') {
    try {
      return await SecurityWalletService.getUnclaimedWallets(token);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('not configured')) {
        return { token, tokenAddress: '', overdue: [], count: 0, configured: false, securityWallet: '' };
      }
      throw err;
    }
  }

  static async getSecurityWalletInfo() {
    // No backend key — the admin connects the security wallet in the UI and signs
    // withdrawUnclaimed via ConnectKit.
    const address = await SecurityWalletService.getSecurityWalletAddress();
    return { address };
  }

  static async getOverdueCommissionsWithAmounts(
    token = 'USDT',
    page = 1,
    limit = 10,
    skip = 0,
    claimFilter: 'all' | 'never' | 'overdue_30d' = 'all',
  ) {
    const result = await this.getOverdueCommissions(token);
    if (!result.overdue?.length) {
      return {
        ...result,
        configured: true,
        totalUnclaimedUSD: 0,
        counts: { all: 0, never: 0, overdue_30d: 0 },
        filter: claimFilter,
        ...paginatedResponse([], 0, page, limit),
      };
    }

    const tokenAddress =
      result.tokenAddress ||
      (token.toUpperCase() === 'USDC' ? await hntrContract.usdc() : await hntrContract.usdt());
    const [amountDecimals, gracePeriod] = await Promise.all([
      getContractAmountDecimals(),
      hntrContract.CLAIM_GRACE_PERIOD().then((v: bigint) => Number(v)).catch(() => 30 * 24 * 60 * 60),
    ]);

    const nowSec = Math.floor(Date.now() / 1000);

    const allWallets = await Promise.all(
      result.overdue.map(async (address) => {
        const [claimable, lastClaimedRaw] = await Promise.all([
          hntrContract.withdrawableCommissions(address, tokenAddress),
          hntrContract.lastClaimedAt(address, tokenAddress),
        ]);
        const amount = Number(ethers.formatUnits(claimable, amountDecimals));
        const lastClaimedAt = Number(lastClaimedRaw);
        const neverClaimed = lastClaimedAt === 0;
        const claimStatus: 'never' | 'overdue_30d' = neverClaimed ? 'never' : 'overdue_30d';
        const daysSinceClaim = neverClaimed
          ? null
          : Math.floor((nowSec - lastClaimedAt) / (24 * 60 * 60));
        const user = await User.findOne({ walletAddress: address.toLowerCase() }).select('username').lean();
        return {
          walletAddress: address,
          username: user?.username || address.slice(0, 8) + '...',
          unclaimedUSD: amount,
          claimStatus,
          lastClaimedAt: neverClaimed ? null : new Date(lastClaimedAt * 1000).toISOString(),
          daysSinceClaim,
          gracePeriodDays: Math.round(gracePeriod / (24 * 60 * 60)),
        };
      }),
    );

    const counts = {
      all: allWallets.length,
      never: allWallets.filter((w) => w.claimStatus === 'never').length,
      overdue_30d: allWallets.filter((w) => w.claimStatus === 'overdue_30d').length,
    };

    const filtered =
      claimFilter === 'all' ? allWallets : allWallets.filter((w) => w.claimStatus === claimFilter);

    const totalUnclaimedUSD = filtered.reduce((sum, w) => sum + w.unclaimedUSD, 0);
    const paginated = paginatedResponse(filtered.slice(skip, skip + limit), filtered.length, page, limit);

    return {
      ...result,
      configured: true,
      filter: claimFilter,
      counts,
      totalUnclaimedUSD: Number(totalUnclaimedUSD.toFixed(2)),
      ...paginated,
    };
  }


  /**
   * Persists an admin unclaimed-commission sweep as UNCLAIMED_WITHDRAWN.
   * Used after ConnectKit-signed withdrawUnclaimed txs (and backend signer path).
   */
  static async recordUnclaimedWithdraw(params: {
    walletAddress: string;
    token: string;
    txHash: string;
    amount: number;
  }) {
    const walletAddress = params.walletAddress.toLowerCase();
    const txHash = params.txHash.toLowerCase();
    const tokenRaw = params.token.trim();
    const token = tokenRaw.startsWith('0x')
      ? tokenRaw.toLowerCase()
      : tokenRaw.toUpperCase() === 'USDC'
        ? String(await hntrContract.usdc()).toLowerCase()
        : String(await hntrContract.usdt()).toLowerCase();

    if (!ethers.isHexString(txHash, 32)) {
      throw new AdminPanelError('INVALID_TX', 'Invalid transaction hash.');
    }
    if (!ethers.isAddress(walletAddress)) {
      throw new AdminPanelError('INVALID_WALLET', 'Invalid wallet address.');
    }
    if (!Number.isFinite(params.amount) || params.amount < 0) {
      throw new AdminPanelError('INVALID_AMOUNT', 'Invalid withdrawal amount.');
    }

    const existing = await Transaction.findOne({
      txHash,
      walletAddress,
      type: 'UNCLAIMED_WITHDRAWN',
      token,
    });
    if (existing) {
      return {
        id: String(existing._id),
        walletAddress,
        txHash,
        token,
        amount: existing.amount,
        type: 'UNCLAIMED_WITHDRAWN' as const,
        status: existing.status,
        duplicate: true,
      };
    }

    const created = await Transaction.create({
      txHash,
      walletAddress,
      type: 'UNCLAIMED_WITHDRAWN',
      token,
      amount: Number(params.amount.toFixed(6)),
      status: 'CONFIRMED',
      timestamp: new Date(),
    });

    logger.info(
      `Recorded UNCLAIMED_WITHDRAWN for ${walletAddress}: -$${params.amount.toFixed(2)} tx=${txHash}`,
    );

    return {
      id: String(created._id),
      walletAddress,
      txHash,
      token,
      amount: created.amount,
      type: 'UNCLAIMED_WITHDRAWN' as const,
      status: 'CONFIRMED' as const,
      duplicate: false,
    };
  }

  static async recalculateVolumes(username: string) {
    const user = await User.findOne({ username });
    if (!user) throw new AdminPanelError('USER_NOT_FOUND', 'User not found.', 404);
    const results = await NetworkService.recalculateUplineVolumes(username);
    return { results, count: results.length };
  }

  static toAdminPoolDto(p: Record<string, any>) {
    return {
      id: String(p._id),
      slug: p.slug,
      name: p.name,
      raisedEth: p.raisedEth,
      status: p.status,
      imageUrl: p.imageUrl,
      depositsPaused: p.depositsPaused,
      collectionName: p.collectionName,
      openSea: p.openSea
        ? {
            collectionSlug: p.openSea.collectionSlug,
            contractAddress: p.openSea.contractAddress,
            chain: p.openSea.chain,
            tokenStandard: p.openSea.tokenStandard,
            protocolAddress: p.openSea.protocolAddress,
            trait: p.openSea.trait,
            offerProtectionEnabled: p.openSea.offerProtectionEnabled,
          }
        : undefined,
      gpProfit: p.gpProfit ?? '0',
      ethProfit: p.ethProfit ?? '0',
      usdtProfit: p.usdtProfit ?? '0',
      participants: p.participants ?? 0,
      daysRemaining: p.daysRemaining ?? 0,
      tags: p.tags,
    };
  }

  static async getStrategyPools(page: number, limit: number, skip: number) {
    const [total, pools] = await Promise.all([
      StrategyPool.countDocuments(),
      StrategyPool.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    const items = pools.map((p) => this.toAdminPoolDto(p));

    return paginatedResponse(items, total, page, limit);
  }

  static async createStrategyPool(data: {
    name: string;
    slug?: string;
    imageUrl?: string;
    collectionName?: string;
    openSea?: PoolOpenSeaInput;
    raisedEth?: number;
    gpProfit?: string;
    ethProfit?: string;
    usdtProfit?: string;
    participants?: number;
    daysRemaining?: number;
    tags?: string[] | string;
  }) {
    const slug =
      data.slug ||
      data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

    const existing = await StrategyPool.findOne({ slug });
    if (existing) throw new AdminPanelError('DUPLICATE_SLUG', 'A pool with this slug already exists.', 409);

    const pool = await StrategyPool.create({
      slug,
      name: data.name,
      imageUrl: data.imageUrl || '/assets/images/pool-default.jpg',
      collectionName: data.collectionName,
      openSea: normalizeOpenSea(data.openSea),
      raisedEth: data.raisedEth !== undefined && data.raisedEth >= 0 ? data.raisedEth : 0,
      gpProfit: data.gpProfit,
      ethProfit: data.ethProfit,
      usdtProfit: data.usdtProfit,
      participants: data.participants,
      daysRemaining: data.daysRemaining,
      tags: normalizeTags(data.tags),
      status: 'OPEN',
      depositsPaused: false,
    });

    return this.toAdminPoolDto(pool.toObject());
  }

  static async updateStrategyPool(
    poolId: string,
    data: Partial<{
      name: string;
      slug: string;
      imageUrl: string;
      status: string;
      depositsPaused: boolean;
      raisedEth: number;
      collectionName: string;
      openSea: PoolOpenSeaInput | null;
      gpProfit: string;
      ethProfit: string;
      usdtProfit: string;
      participants: number;
      daysRemaining: number;
      tags: string[] | string;
    }>,
  ) {
    const pool = await StrategyPool.findById(poolId);
    if (!pool) throw new AdminPanelError('POOL_NOT_FOUND', 'Strategy pool not found.', 404);

    if (data.slug !== undefined) {
      const nextSlug = String(data.slug)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      if (!nextSlug) throw new AdminPanelError('INVALID_SLUG', 'Slug cannot be empty.', 400);
      if (nextSlug !== pool.slug) {
        const clash = await StrategyPool.findOne({ slug: nextSlug, _id: { $ne: pool._id } });
        if (clash) throw new AdminPanelError('DUPLICATE_SLUG', 'A pool with this slug already exists.', 409);
        pool.slug = nextSlug;
      }
    }
    if (data.name !== undefined) pool.name = data.name;
    if (data.imageUrl !== undefined) pool.imageUrl = data.imageUrl;
    if (data.status !== undefined) pool.status = data.status as 'OPEN' | 'CLOSED' | 'COMPLETED';
    if (data.depositsPaused !== undefined) pool.depositsPaused = data.depositsPaused;
    if (data.raisedEth !== undefined) pool.raisedEth = data.raisedEth;
    if (data.collectionName !== undefined) pool.collectionName = data.collectionName;
    if (data.openSea !== undefined) pool.openSea = data.openSea === null ? undefined : normalizeOpenSea(data.openSea);
    if (data.gpProfit !== undefined) pool.gpProfit = data.gpProfit;
    if (data.ethProfit !== undefined) pool.ethProfit = data.ethProfit;
    if (data.usdtProfit !== undefined) pool.usdtProfit = data.usdtProfit;
    if (data.participants !== undefined) pool.participants = data.participants;
    if (data.daysRemaining !== undefined) pool.daysRemaining = data.daysRemaining;
    if (data.tags !== undefined) pool.tags = normalizeTags(data.tags);

    await pool.save();

    return this.toAdminPoolDto(pool.toObject());
  }

  static async deleteStrategyPool(poolId: string) {
    const pool = await StrategyPool.findByIdAndDelete(poolId);
    if (!pool) throw new AdminPanelError('POOL_NOT_FOUND', 'Strategy pool not found.', 404);
    return { id: String(pool._id), name: pool.name };
  }

  static async getMaintenanceSettings() {
    const settings = await AdminSettings.findOneAndUpdate(
      { key: 'global' },
      {},
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return {
      maintenanceMode: settings.maintenanceMode,
      maintenanceMessage: settings.maintenanceMessage,
    };
  }

  static async setMaintenanceSettings(maintenanceMode: boolean, maintenanceMessage?: string) {
    const settings = await AdminSettings.findOneAndUpdate(
      { key: 'global' },
      { maintenanceMode, ...(maintenanceMessage !== undefined ? { maintenanceMessage } : {}) },
      { upsert: true, new: true },
    );
    return {
      maintenanceMode: settings.maintenanceMode,
      maintenanceMessage: settings.maintenanceMessage,
    };
  }
}
