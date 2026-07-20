import { ethers } from 'ethers';
import User from '../models/User';
import Transaction from '../models/Transaction';
import StrategyPool from '../models/StrategyPool';
import AdminUserOverride from '../models/AdminUserOverride';
import AdminSettings from '../models/AdminSettings';
import PointsLedger from '../models/PointsLedger';
import { RewardsService } from './rewards.service';
import { NetworkService } from './network.service';
import { CompanyWalletService } from './companyWallet.service';
import { hntrContract, getErc20, getContractAmountDecimals } from './contract.service';
import { LEADERSHIP_ELIGIBLE_RANKS, getLeadershipShares } from '../constants';
import { paginatedResponse, sanitizeSearch } from '../utils/pagination';

export class AdminPanelError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const VALID_TIERS = ['None', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'] as const;
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

const TX_TYPE_MAP: Record<string, string[]> = {
  all: [],
  commissions: ['COMMISSION_EARNED', 'COMMISSION_CLAIM', 'COMMISSION_WITHDRAWN', 'COMPANY_WALLET_WITHDRAWN'],
  purchases: ['PURCHASE', 'UPGRADE'],
  withdrawals: ['COMMISSION_WITHDRAWN', 'COMPANY_WALLET_WITHDRAWN', 'COMMISSION_CLAIM'],
};

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
      commissionAgg,
      thisMonthUsers,
      lastMonthUsers,
      thisMonthVolume,
      lastMonthVolume,
      treasuryAddress,
      leadershipAddress,
      achievementAddress,
      poolAddress,
      companyAddress,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ tier: { $ne: 'None' } }),
      Transaction.aggregate([
        { $match: { type: { $in: ['PURCHASE', 'UPGRADE'] }, status: 'CONFIRMED' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: { type: 'COMMISSION_EARNED', status: 'CONFIRMED' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
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
            type: { $in: ['PURCHASE', 'UPGRADE'] },
            status: 'CONFIRMED',
            timestamp: { $gte: lastMonth.start, $lt: lastMonth.end },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      hntrContract.treasuryWallet(),
      hntrContract.leadershipWallet(),
      hntrContract.achievementWallet(),
      hntrContract.poolWallet(),
      hntrContract.companyWallet(),
    ]);

    const totalVolume = volumeAgg[0]?.total ?? 0;
    const totalCommissions = commissionAgg[0]?.total ?? 0;
    const thisMonthVol = thisMonthVolume[0]?.total ?? 0;
    const lastMonthVol = lastMonthVolume[0]?.total ?? 0;

    const [treasuryBal, leadershipBal, achievementBal, poolBal, companyBal] = await Promise.all([
      readWalletStablecoinBalances(String(treasuryAddress)),
      readWalletStablecoinBalances(String(leadershipAddress)),
      readWalletStablecoinBalances(String(achievementAddress)),
      readWalletStablecoinBalances(String(poolAddress)),
      readWalletStablecoinBalances(String(companyAddress)),
    ]);

    const commissionPct =
      totalVolume > 0 ? `${Math.round((totalCommissions / totalVolume) * 100)}% distribution` : '0% distribution';

    const treasuryTotal = treasuryBal.totalUsd;
    const companyCutPct =
      totalVolume > 0 ? `${Math.round((treasuryTotal / totalVolume) * 100)}% company cut` : '25% company cut';

    return {
      totalUsers,
      totalVolume,
      totalCommissions,
      treasuryBalance: treasuryTotal,
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
          value: `$${(totalVolume / 1_000_000).toFixed(1)}M`.replace('.0M', 'M'),
          subValue: `${pctChange(thisMonthVol, lastMonthVol)} this month`,
        },
        {
          title: 'Total Commissions',
          value: `$${(totalCommissions / 1_000_000).toFixed(2)}M`,
          subValue: commissionPct,
        },
        {
          title: 'Treasury Balance',
          value: `$${(treasuryTotal / 1_000_000).toFixed(2)}M`,
          subValue: companyCutPct,
        },
        { title: 'Sold Memberships', value: soldMemberships, subValue: 'All tiers' },
      ],
      walletSummary: {
        treasury: { address: String(treasuryAddress).toLowerCase(), ...treasuryBal },
        leadership: { address: String(leadershipAddress).toLowerCase(), ...leadershipBal },
        achievement: { address: String(achievementAddress).toLowerCase(), ...achievementBal },
        pool: { address: String(poolAddress).toLowerCase(), ...poolBal },
        company: { address: String(companyAddress).toLowerCase(), ...companyBal },
      },
    };
  }

  static async getRecentActivity(page: number, limit: number, skip: number) {
    const filter = {
      type: {
        $in: ['PURCHASE', 'UPGRADE', 'COMMISSION_EARNED', 'COMMISSION_WITHDRAWN', 'COMPANY_WALLET_WITHDRAWN'] as const,
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

    const items = rows.map((tx) => ({
      id: String(tx._id),
      type: tx.type === 'COMMISSION_EARNED' ? 'Commission Earned' : tx.type === 'PURCHASE' ? 'Membership Purchase' : tx.type === 'UPGRADE' ? 'Membership Upgrade' : 'Withdrawal',
      user: userByWallet.get(tx.walletAddress.toLowerCase()) || tx.walletAddress.slice(0, 6) + '...',
      walletAddress: tx.walletAddress,
      amount: tx.amount,
      token: tx.token || 'USDT',
      status: tx.status,
      timestamp: tx.timestamp,
    }));

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
      const tier = override?.tierOverride || u.tier;
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

  static async overrideUserProfile(username: string, tier?: string, rank?: string) {
    const user = await User.findOne({ username });
    if (!user) throw new AdminPanelError('USER_NOT_FOUND', 'User not found.', 404);

    if (tier && !VALID_TIERS.includes(tier as (typeof VALID_TIERS)[number])) {
      throw new AdminPanelError('INVALID_TIER', `Invalid tier. Allowed: ${VALID_TIERS.join(', ')}`);
    }
    if (rank && !VALID_RANKS.includes(rank as (typeof VALID_RANKS)[number])) {
      throw new AdminPanelError('INVALID_RANK', `Invalid rank. Allowed: ${VALID_RANKS.join(', ')}`);
    }

    const update: Record<string, unknown> = {};
    if (tier !== undefined) update.tierOverride = tier === user.tier ? null : tier;
    if (rank !== undefined) update.rankOverride = rank === user.rank ? null : rank;

    const override = await AdminUserOverride.findOneAndUpdate(
      { username: username.toLowerCase() },
      { $set: update },
      { upsert: true, new: true },
    );

    return {
      username: user.username,
      tier: override.tierOverride || user.tier,
      rank: override.rankOverride || user.rank,
      message: 'User profile overrides saved.',
    };
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

    const items = rows.map((tx) => {
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
        token: tx.token || 'USDT',
        hntrPoints: relatedPoints?.amount ?? null,
        txHash: tx.txHash || null,
        status: tx.status,
        tier: tx.tier,
        level: tx.level,
      };
    });

    return paginatedResponse(items, total, page, limit);
  }

  static async getWalletBalances() {
    const [treasury, leadership, achievement, pool, company] = await Promise.all([
      hntrContract.treasuryWallet(),
      hntrContract.leadershipWallet(),
      hntrContract.achievementWallet(),
      hntrContract.poolWallet(),
      hntrContract.companyWallet(),
    ]);

    const wallets = [
      { name: 'Achievement Wallet', key: 'achievement', address: String(achievement) },
      { name: 'Leadership Wallet', key: 'leadership', address: String(leadership) },
      { name: 'Pool Wallet', key: 'pool', address: String(pool) },
      { name: 'Company Wallet', key: 'company', address: String(company) },
      { name: 'Treasury Wallet', key: 'treasury', address: String(treasury) },
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
    const validKeys = ['treasury', 'leadership', 'achievement', 'pool', 'company'] as const;
    if (!validKeys.includes(walletKey as (typeof validKeys)[number])) {
      throw new AdminPanelError('INVALID_WALLET', 'Unknown wallet key.');
    }

    const addressMap: Record<string, () => Promise<string>> = {
      treasury: () => hntrContract.treasuryWallet(),
      leadership: () => hntrContract.leadershipWallet(),
      achievement: () => hntrContract.achievementWallet(),
      pool: () => hntrContract.poolWallet(),
      company: () => hntrContract.companyWallet(),
    };

    const walletAddress = String(await addressMap[walletKey]()).toLowerCase();

    const query = {
      $or: [
        { walletAddress: walletAddress },
        { type: { $in: ['COMMISSION_EARNED'] }, lockedAmount: { $gt: 0 } },
      ],
    };

    if (walletKey === 'pool') {
      const [total, rows] = await Promise.all([
        Transaction.countDocuments({ lockedAmount: { $gt: 0 } }),
        Transaction.find({ lockedAmount: { $gt: 0 } }).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      ]);
      const items = rows.map((tx) => ({
        id: String(tx._id),
        type: tx.type,
        walletAddress: tx.walletAddress,
        amount: tx.lockedAmount,
        token: tx.token,
        timestamp: tx.timestamp,
        txHash: tx.txHash,
      }));
      return paginatedResponse(items, total, page, limit);
    }

    const [total, rows] = await Promise.all([
      Transaction.countDocuments({ walletAddress }),
      Transaction.find({ walletAddress }).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
    ]);

    const items = rows.map((tx) => ({
      id: String(tx._id),
      type: tx.type,
      walletAddress: tx.walletAddress,
      amount: tx.amount,
      token: tx.token,
      timestamp: tx.timestamp,
      txHash: tx.txHash,
    }));

    return paginatedResponse(items, total, page, limit);
  }

  static async getLeadershipPreview() {
    const leadershipWallet = await hntrContract.leadershipWallet();
    const balances = await readWalletStablecoinBalances(String(leadershipWallet));

    const eligibleUsers = await User.find({ rank: { $in: [...LEADERSHIP_ELIGIBLE_RANKS] } })
      .select('username rank walletAddress')
      .lean();

    let totalShares = 0;
    const hunters = eligibleUsers.map((u) => {
      const shares = getLeadershipShares(u.rank);
      totalShares += shares;
      return { username: u.username, rank: u.rank, shares };
    });

    return {
      poolBalanceUSD: balances.totalUsd,
      poolTokens: balances.tokens,
      eligibleCount: eligibleUsers.length,
      eligibleUsers: hunters,
      totalShares,
    };
  }

  static async distributeLeadership() {
    const payouts = await RewardsService.calculateMonthlyLeadershipPool();
    return {
      payouts,
      paid: payouts.filter((p: { status?: string }) => p.status === 'PAID').length,
      failed: payouts.filter((p: { status?: string }) => p.status === 'FAILED').length,
    };
  }

  static async distributeAchievement() {
    const payouts = await RewardsService.disbursePendingAchievementBonuses();
    return { payouts, paid: payouts.length };
  }

  static async getRankBonusReport(page: number, limit: number, skip: number) {
    const report = await RewardsService.generateRankBonusReport();
    const total = report.length;
    const items = report.slice(skip, skip + limit);
    return paginatedResponse(items, total, page, limit);
  }

  static async getOverdueCommissions(token = 'USDT') {
    try {
      return await CompanyWalletService.getOverdueWallets(token);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('not configured')) {
        return { token, tokenAddress: '', overdue: [], count: 0, configured: false };
      }
      throw err;
    }
  }

  static async getOverdueCommissionsWithAmounts(token = 'USDT', page = 1, limit = 10, skip = 0) {
    const result = await this.getOverdueCommissions(token);
    if (!result.overdue?.length) {
      return {
        ...result,
        totalUnclaimedUSD: 0,
        ...paginatedResponse([], 0, page, limit),
      };
    }

    const tokenAddress =
      result.tokenAddress ||
      (token.toUpperCase() === 'USDC' ? await hntrContract.usdc() : await hntrContract.usdt());
    const amountDecimals = await getContractAmountDecimals();

    const allWallets = await Promise.all(
      result.overdue.map(async (address) => {
        const claimable = await hntrContract.withdrawableCommissions(address, tokenAddress);
        const amount = Number(ethers.formatUnits(claimable, amountDecimals));
        const user = await User.findOne({ walletAddress: address.toLowerCase() }).select('username').lean();
        return {
          walletAddress: address,
          username: user?.username || address.slice(0, 8) + '...',
          unclaimedUSD: amount,
        };
      }),
    );

    const totalUnclaimedUSD = allWallets.reduce((sum, w) => sum + w.unclaimedUSD, 0);
    const paginated = paginatedResponse(allWallets.slice(skip, skip + limit), allWallets.length, page, limit);

    return {
      ...result,
      totalUnclaimedUSD: Number(totalUnclaimedUSD.toFixed(2)),
      ...paginated,
    };
  }

  static async claimCommissionsForWallets(walletAddresses: string[], token = 'USDT') {
    const results = [];
    for (const wallet of walletAddresses) {
      try {
        const result = await CompanyWalletService.withdrawForUser(wallet, token);
        results.push({ walletAddress: wallet, success: true, ...result });
      } catch (err: unknown) {
        results.push({
          walletAddress: wallet,
          success: false,
          error: err instanceof Error ? err.message : 'Withdrawal failed',
        });
      }
    }
    return results;
  }

  static async recalculateVolumes(username: string) {
    const user = await User.findOne({ username });
    if (!user) throw new AdminPanelError('USER_NOT_FOUND', 'User not found.', 404);
    const results = await NetworkService.recalculateUplineVolumes(username);
    return { results, count: results.length };
  }

  static async ensureDefaultPools() {
    const count = await StrategyPool.countDocuments();
    if (count > 0) return;

    await StrategyPool.insertMany([
      {
        slug: 'bored-ape-yacht-club',
        name: 'Bored Ape Yacht Club',
        targetEth: 35,
        raisedEth: 28.5,
        status: 'OPEN',
        imageUrl: '/assets/images/image-6.jpg',
        collectionName: 'BAYC',
      },
      {
        slug: 'pudgy-penguins',
        name: 'Pudgy Penguins',
        targetEth: 8.5,
        raisedEth: 4.25,
        status: 'OPEN',
        imageUrl: '/assets/images/image-10.jpg',
        collectionName: 'Pudgy Penguins',
      },
      {
        slug: 'azuki',
        name: 'Azuki',
        targetEth: 12,
        raisedEth: 1.2,
        status: 'OPEN',
        imageUrl: '/assets/images/image-11.jpg',
        collectionName: 'Azuki',
      },
    ]);
  }

  static async getStrategyPools(page: number, limit: number, skip: number) {
    await this.ensureDefaultPools();
    const [total, pools] = await Promise.all([
      StrategyPool.countDocuments(),
      StrategyPool.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    const items = pools.map((p) => ({
      id: String(p._id),
      slug: p.slug,
      name: p.name,
      targetEth: p.targetEth,
      raisedEth: p.raisedEth,
      progress: p.targetEth > 0 ? Math.min(100, Math.round((p.raisedEth / p.targetEth) * 100)) : 0,
      status: p.status,
      imageUrl: p.imageUrl,
      depositsPaused: p.depositsPaused,
      collectionName: p.collectionName,
    }));

    return paginatedResponse(items, total, page, limit);
  }

  static async createStrategyPool(data: {
    name: string;
    slug?: string;
    targetEth: number;
    imageUrl?: string;
    collectionName?: string;
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
      targetEth: data.targetEth,
      imageUrl: data.imageUrl || '/assets/images/pool-default.jpg',
      collectionName: data.collectionName,
      raisedEth: 0,
      status: 'OPEN',
      depositsPaused: false,
    });

    return {
      id: String(pool._id),
      slug: pool.slug,
      name: pool.name,
      targetEth: pool.targetEth,
      raisedEth: pool.raisedEth,
      status: pool.status,
      imageUrl: pool.imageUrl,
      depositsPaused: pool.depositsPaused,
    };
  }

  static async updateStrategyPool(
    poolId: string,
    data: Partial<{
      name: string;
      imageUrl: string;
      targetEth: number;
      status: string;
      depositsPaused: boolean;
      raisedEth: number;
    }>,
  ) {
    const pool = await StrategyPool.findById(poolId);
    if (!pool) throw new AdminPanelError('POOL_NOT_FOUND', 'Strategy pool not found.', 404);

    if (data.name !== undefined) pool.name = data.name;
    if (data.imageUrl !== undefined) pool.imageUrl = data.imageUrl;
    if (data.targetEth !== undefined) pool.targetEth = data.targetEth;
    if (data.status !== undefined) pool.status = data.status as 'OPEN' | 'CLOSED' | 'COMPLETED';
    if (data.depositsPaused !== undefined) pool.depositsPaused = data.depositsPaused;
    if (data.raisedEth !== undefined) pool.raisedEth = data.raisedEth;

    await pool.save();

    return {
      id: String(pool._id),
      slug: pool.slug,
      name: pool.name,
      targetEth: pool.targetEth,
      raisedEth: pool.raisedEth,
      progress: pool.targetEth > 0 ? Math.min(100, Math.round((pool.raisedEth / pool.targetEth) * 100)) : 0,
      status: pool.status,
      imageUrl: pool.imageUrl,
      depositsPaused: pool.depositsPaused,
    };
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
