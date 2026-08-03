import User, { IUser } from '../models/User';
import Payout, { IPayoutBreakdownEntry } from '../models/Payout';
import AchievementBonus from '../models/AchievementBonus';
import { ethers } from 'ethers';
import { hntrContract, contractABI, provider, getErc20, getContractAmountDecimals, CONTRACT_ADDRESS } from './contract.service';
import { ENV } from '../config/env';
import {
  getAchievementBonusAmount,
  getLeadershipShares,
  LEADERSHIP_ELIGIBLE_RANKS,
  LEADERSHIP_SHARES,
  RANK_ACHIEVEMENT_BONUSES,
  ranksNewlyAchieved,
} from '../constants';
import { NotificationService } from './notification.service';

type StablecoinPool = {
  symbol: 'USDT' | 'USDC';
  address: string;
  decimals: number;
  /** Mutable remaining balance — decremented as payouts allocate funds. */
  rawBalance: bigint;
};

type TokenSlice = { pool: StablecoinPool; amountRaw: bigint };

export class RewardsService {
  /**
   * Plan `owedRaw` across pools by draining USDT first, then USDC.
   * Does not mutate balances — caller applies after successful transfers.
   * Returns null if combined remaining is insufficient.
   */
  private static planUsdtFirst(pools: StablecoinPool[], owedRaw: bigint): TokenSlice[] | null {
    const zero = BigInt(0);
    if (owedRaw <= zero) return [];

    const ordered = (['USDT', 'USDC'] as const)
      .map((symbol) => pools.find((p) => p.symbol === symbol))
      .filter((p): p is StablecoinPool => Boolean(p));

    const available = ordered.reduce((sum, p) => sum + p.rawBalance, zero);
    if (available < owedRaw) return null;

    const remainingBySymbol: Record<string, bigint> = {};
    for (const pool of ordered) remainingBySymbol[pool.symbol] = pool.rawBalance;

    let remaining = owedRaw;
    const slices: TokenSlice[] = [];
    for (const pool of ordered) {
      if (remaining <= zero) break;
      const availableHere = remainingBySymbol[pool.symbol] || zero;
      if (availableHere <= zero) continue;
      const take = availableHere < remaining ? availableHere : remaining;
      if (take <= zero) continue;
      slices.push({ pool, amountRaw: take });
      remainingBySymbol[pool.symbol] = availableHere - take;
      remaining -= take;
    }
    return remaining === zero ? slices : null;
  }

  private static applySlices(slices: TokenSlice[]) {
    for (const { pool, amountRaw } of slices) {
      pool.rawBalance -= amountRaw;
    }
  }

  private static async loadStablecoinPools(walletAddress: string): Promise<StablecoinPool[]> {
    const [usdtAddress, usdcAddress, amountDecimals] = await Promise.all([
      hntrContract.usdt(),
      hntrContract.usdc(),
      getContractAmountDecimals(),
    ]);

    return Promise.all(
      (
        [
          { symbol: 'USDT' as const, address: usdtAddress },
          { symbol: 'USDC' as const, address: usdcAddress },
        ] as const
      ).map(async ({ symbol, address }) => {
        const erc20 = getErc20(address);
        const rawBalance = (await erc20.balanceOf(walletAddress)) as bigint;
        return { symbol, address, decimals: amountDecimals, rawBalance };
      }),
    );
  }

  /**
   * Withdraws accrued protocol balance for both USDT and USDC from the contract.
   * Under pull-payment, protocol wallets (leadership, achievement, etc.) must call
   * this before they can transfer funds to users.
   */
  private static async withdrawProtocolBalances(walletSigner: ethers.Wallet) {
    const membershipWithSigner = new ethers.Contract(CONTRACT_ADDRESS, contractABI, walletSigner);
    const [usdtAddress, usdcAddress] = await Promise.all([
      hntrContract.usdt(),
      hntrContract.usdc(),
    ]);

    for (const [symbol, tokenAddress] of [['USDT', usdtAddress], ['USDC', usdcAddress]] as const) {
      const balance: bigint = await hntrContract.protocolBalances(walletSigner.address, tokenAddress);
      if (balance > BigInt(0)) {
        try {
          const tx = await membershipWithSigner.withdrawProtocolBalance(tokenAddress);
          await tx.wait(1);
          console.log(`Withdrew ${symbol} protocol balance (${balance}) for ${walletSigner.address}`);
        } catch (err: any) {
          console.error(`Failed to withdraw ${symbol} protocol balance: ${err.message}`);
        }
      }
    }
  }

  /**
   * Admin/report view of pending + paid one-time rank achievement bonuses.
   */
  static async generateRankBonusReport() {
    const bonuses = await AchievementBonus.find().sort({ createdAt: -1 }).lean();
    return bonuses.map((b) => ({
      username: b.username,
      walletAddress: b.walletAddress,
      rank: b.rank,
      bonusAmount: b.amountUSD,
      status: b.status,
      txHash: b.txHash,
      createdAt: b.createdAt,
      paidAt: b.paidAt,
    }));
  }

  /**
   * Create PENDING AchievementBonus rows for every rank newly crossed between
   * previousRank → newRank (unique per wallet+rank). Prefer calling with
   * previousRank=None and newRank=volume-qualified rank so forced display ranks
   * never unlock bonuses early. Does not pay — the daily cron does that when
   * achievementWallet is funded enough.
   */
  static async enqueueAchievementBonuses(
    user: Pick<IUser, 'username' | 'walletAddress'>,
    previousRank: string,
    newRank: string,
  ) {
    const newlyAchieved = ranksNewlyAchieved(previousRank, newRank);
    const created = [];

    for (const rank of newlyAchieved) {
      const amountUSD = getAchievementBonusAmount(rank);
      if (amountUSD <= 0) continue;

      try {
        const bonus = await AchievementBonus.create({
          walletAddress: user.walletAddress.toLowerCase(),
          username: user.username,
          rank,
          amountUSD,
          status: 'PENDING',
          createdAt: new Date(),
        });
        created.push(bonus);
        console.log(
          `Queued achievement bonus for ${user.username}: ${rank} $${amountUSD}`,
        );
      } catch (err: any) {
        // Duplicate key = already enqueued/paid for this rank — skip quietly.
        if (err?.code === 11000) {
          console.log(
            `Achievement bonus already exists for ${user.username} / ${rank} — skipping`,
          );
          continue;
        }
        throw err;
      }
    }

    return created;
  }

  /**
   * Pays PENDING achievement bonuses oldest-first.
   * Funding order: drain USDT first, then USDC (may split one bonus across both when needed).
   */
  static async disbursePendingAchievementBonuses() {
    if (!ENV.ACHIEVEMENT_WALLET_PRIVATE_KEY) {
      throw new Error(
        'ACHIEVEMENT_WALLET_PRIVATE_KEY not found in environment for automated payouts!',
      );
    }

    const achievementWallet = await hntrContract.achievementWallet();
    const adminWallet = new ethers.Wallet(ENV.ACHIEVEMENT_WALLET_PRIVATE_KEY, provider);
    if (adminWallet.address.toLowerCase() !== String(achievementWallet).toLowerCase()) {
      throw new Error(
        `ACHIEVEMENT_WALLET_PRIVATE_KEY address ${adminWallet.address} does not match on-chain achievementWallet ${achievementWallet}`,
      );
    }

    // Pull any contract-held protocol balance into the wallet before reading ERC20 balances.
    await this.withdrawProtocolBalances(adminWallet);

    const pending = await AchievementBonus.find({ status: 'PENDING' }).sort({ createdAt: 1 });
    if (pending.length === 0) {
      console.log('No pending achievement bonuses to disburse.');
      return [];
    }

    const tokenPools = await this.loadStablecoinPools(String(achievementWallet));
    tokenPools.forEach((p) =>
      console.log(
        `Live Achievement Wallet Balance: $${ethers.formatUnits(p.rawBalance, p.decimals)} ${p.symbol}`,
      ),
    );

    const paidOut = [];
    const zero = BigInt(0);

    for (const bonus of pending) {
      const precision = Math.min(tokenPools[0]?.decimals ?? 6, 8);
      const amountRaw = ethers.parseUnits(bonus.amountUSD.toFixed(precision), tokenPools[0].decimals);
      if (amountRaw <= zero) continue;

      const slices = this.planUsdtFirst(tokenPools, amountRaw);
      if (!slices || slices.length === 0) {
        console.log(
          `Skipping ${bonus.username} ${bonus.rank} $${bonus.amountUSD} — achievement wallet underfunded (USDT-first)`,
        );
        continue;
      }

      const transferMeta: { symbol: string; amount: number; txHash: string }[] = [];

      try {
        console.log(
          `Paying achievement bonus $${bonus.amountUSD} to ${bonus.walletAddress} (${bonus.rank}) ` +
            `via ${slices.map((s) => s.pool.symbol).join('→')}...`,
        );

        for (const { pool, amountRaw: sliceRaw } of slices) {
          const amount = Number(ethers.formatUnits(sliceRaw, pool.decimals));
          const erc20WithSigner = getErc20(pool.address).connect(adminWallet) as ethers.Contract;
          const tx = await erc20WithSigner.transfer(bonus.walletAddress, sliceRaw);
          console.log(`  ${pool.symbol} ${amount} tx: ${tx.hash}`);
          await tx.wait(1);
          transferMeta.push({ symbol: pool.symbol, amount, txHash: tx.hash });
        }

        this.applySlices(slices);

        const primary = transferMeta[0];
        bonus.status = 'PAID';
        bonus.token = transferMeta.map((t) => t.symbol).join('+');
        bonus.tokenAddress = slices[0].pool.address;
        bonus.txHash = primary.txHash;
        bonus.paidAt = new Date();
        await bonus.save();
        paidOut.push(bonus);

        await NotificationService.createQuiet({
          walletAddress: bonus.walletAddress,
          type: 'ACHIEVEMENT_PAYOUT',
          title: 'Rank Bonus deposited',
          sub: `$${bonus.amountUSD.toFixed(2)} auto-deposited for reaching ${bonus.rank}.`,
          link: 'VIEW NETWORK',
          meta: {
            rank: bonus.rank,
            amountUSD: bonus.amountUSD,
            txHash: primary.txHash,
            token: bonus.token,
            transfers: transferMeta,
          },
        });

        console.log(`Paid ${bonus.username}: $${bonus.amountUSD} for ${bonus.rank}`);
      } catch (e: any) {
        console.error(
          `Failed to pay achievement bonus to ${bonus.walletAddress}:`,
          e.message,
        );
        // Keep PENDING. Reload live balances after a partial on-chain transfer.
        const refreshed = await this.loadStablecoinPools(String(achievementWallet));
        for (const pool of tokenPools) {
          const live = refreshed.find((r) => r.symbol === pool.symbol);
          if (live) pool.rawBalance = live.rawBalance;
        }
      }
    }

    console.log(
      `✅ Achievement disburse complete. Paid ${paidOut.length} of ${pending.length} pending.`,
    );
    return paidOut;
  }

  /**
   * Live USDT/USDC balances available to a protocol wallet (leadership or achievement).
   * Includes both the wallet's ERC20 balance AND unclaimed protocol balance still held
   * inside the contract (pull-payment model).
   */
  private static async getPoolWalletBalances(poolWallet: string) {
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
      ).map(async ({ symbol, address: tokenAddress }) => {
        const erc20 = getErc20(tokenAddress);
        const [rawBalance, protocolBalance] = await Promise.all([
          erc20.balanceOf(poolWallet),
          hntrContract.protocolBalances(poolWallet, tokenAddress),
        ]);
        const walletBal = Number(ethers.formatUnits(rawBalance, amountDecimals));
        const contractBal = Number(ethers.formatUnits(protocolBalance, amountDecimals));
        return {
          symbol,
          address: tokenAddress,
          balance: Number((walletBal + contractBal).toFixed(6)),
        };
      }),
    );

    const totalUSD = tokens.reduce((sum, t) => sum + t.balance, 0);
    return {
      walletAddress: String(poolWallet).toLowerCase(),
      tokens,
      totalUSD: Number(totalUSD.toFixed(2)),
    };
  }

  /** Status payload for the Network page Rank Bonus card. */
  static async getAchievementStatus(walletAddress: string) {
    const address = walletAddress.toLowerCase();
    const user = await User.findOne({ walletAddress: address });
    if (user) {
      const { NetworkService } = await import('./network.service');
      await NetworkService.syncAdminOverrides(user);
    }

    // Fetch after sync so newly enqueued PENDING bonuses show on the Rank Bonus card.
    const bonuses = await AchievementBonus.find({ walletAddress: address })
      .sort({ createdAt: -1 })
      .lean();

    const achievementWallet = await hntrContract.achievementWallet();
    const walletBalances = await this.getPoolWalletBalances(achievementWallet);
    const poolBalanceUSD = walletBalances.totalUSD;

    const lifetimePaidUSD = bonuses
      .filter((b) => b.status === 'PAID')
      .reduce((sum, b) => sum + (b.amountUSD || 0), 0);
    const pendingBonuses = bonuses.filter((b) => b.status === 'PENDING');
    const pendingUSD = pendingBonuses.reduce((sum, b) => sum + (b.amountUSD || 0), 0);
    const hasPending = pendingBonuses.length > 0;
    const hasPaid = lifetimePaidUSD > 0;

    // How much of the pending queue this wallet could cover right now (oldest-first, full amounts only).
    let payableNowUSD = 0;
    let remainingPool = poolBalanceUSD;
    const pendingOldestFirst = [...pendingBonuses].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    for (const b of pendingOldestFirst) {
      if (remainingPool + 1e-9 >= b.amountUSD) {
        payableNowUSD += b.amountUSD;
        remainingPool -= b.amountUSD;
      }
    }
    const waitingOnFundingUSD = Math.max(0, pendingUSD - payableNowUSD);

    const pendingBreakdown = pendingOldestFirst
      .map((b) => `${b.rank} $${Number(b.amountUSD).toFixed(2)}`)
      .join(' + ');

    let message: string;
    if (hasPending) {
      message =
        `$${pendingUSD.toFixed(2)} pending` +
        (pendingBreakdown ? ` (${pendingBreakdown})` : '') +
        `. $${payableNowUSD.toFixed(2)} can pay from the current $${poolBalanceUSD.toFixed(2)} pool` +
        (waitingOnFundingUSD > 0
          ? `; $${waitingOnFundingUSD.toFixed(2)} waits until the achievement wallet is topped up.`
          : '.') +
        ` Paid oldest-first; funding drains USDT first, then USDC.`;
    } else if (hasPaid) {
      message = `$${lifetimePaidUSD.toFixed(2)} lifetime rank bonuses auto-deposited to your wallet.`;
    } else {
      message =
        'No rank bonus yet — reach Scout or above to unlock one-time achievement bonuses.';
    }

    return {
      walletAddress: address,
      username: user?.username || null,
      rank: user?.rank || 'None',
      bonusTable: RANK_ACHIEVEMENT_BONUSES,
      lifetimePaidUSD: Number(lifetimePaidUSD.toFixed(2)),
      pendingUSD: Number(pendingUSD.toFixed(2)),
      payableNowUSD: Number(payableNowUSD.toFixed(2)),
      waitingOnFundingUSD: Number(waitingOnFundingUSD.toFixed(2)),
      hasPending,
      hasPaid,
      message,
      walletBalances,
      poolBalanceUSD,
      bonuses,
      lastBonus: bonuses[0] || null,
    };
  }

  /**
   * Live leadership pool balances + this wallet's share entitlement.
   * Users with 0 shares (below Hunter) get an explicit "no shares" status;
   * users with shares see their weight and an estimated next payout from the
   * current on-chain pool (pro-rata by LEADERSHIP_SHARES).
   */
  static async getLeadershipStatus(walletAddress: string) {
    const address = walletAddress.toLowerCase();
    const user = await User.findOne({ walletAddress: address });
    if (user) {
      const { NetworkService } = await import('./network.service');
      await NetworkService.syncAdminOverrides(user);
    }
    const rank = user?.rank || 'None';
    const shares = getLeadershipShares(rank);
    const hasShares = shares > 0;

    const leadershipWallet = await hntrContract.leadershipWallet();
    const walletBalances = await this.getPoolWalletBalances(leadershipWallet);
    const poolBalanceUSD = walletBalances.totalUSD;

    const eligibleUsers = await User.find({
      rank: { $in: [...LEADERSHIP_ELIGIBLE_RANKS] },
    }).select('rank walletAddress username');

    let totalShares = 0;
    for (const u of eligibleUsers) {
      totalShares += getLeadershipShares(u.rank);
    }

    const estimatedPayoutUSD =
      hasShares && totalShares > 0 ? (shares / totalShares) * poolBalanceUSD : 0;

    const payouts = await Payout.find({ walletAddress: address }).sort({ createdAt: -1 }).lean();
    const lifetimePaidUSD = payouts
      .filter((p) => p.status === 'PAID')
      .reduce((sum, p) => sum + (p.amountUSDC || 0), 0);

    const message = hasShares
      ? `You have ${shares} leadership share${shares === 1 ? '' : 's'} as ${rank}. ` +
        `Est. next payout: $${estimatedPayoutUSD.toFixed(2)} from the current pool.`
      : `You don't have any shares. Reach Hunter rank or above to earn a share of the monthly leadership pool.`;

    return {
      walletAddress: address,
      username: user?.username || null,
      rank,
      shares,
      hasShares,
      totalShares,
      eligibleUserCount: eligibleUsers.length,
      poolBalanceUSD: Number(poolBalanceUSD.toFixed(2)),
      walletBalances,
      estimatedPayoutUSD: Number(estimatedPayoutUSD.toFixed(2)),
      lifetimePaidUSD: Number(lifetimePaidUSD.toFixed(2)),
      shareWeights: LEADERSHIP_SHARES,
      message,
      lastPayout: payouts[0] || null,
      payouts,
    };
  }

  /**
   * Monthly leadership pool distribution.
   *
   * Each eligible user's USD entitlement is `totalPool * shares / totalShares`.
   * Entitlements are funded by draining USDT first, then USDC (may split one
   * user's payout across both tokens). Integer dust stays in the wallet.
   */
  static async calculateMonthlyLeadershipPool() {
    const leadershipWallet = await hntrContract.leadershipWallet();

    if (!ENV.LEADERSHIP_PRIVATE_KEY) {
      throw new Error('LEADERSHIP_PRIVATE_KEY not found in environment for automated payouts!');
    }

    const adminWallet = new ethers.Wallet(ENV.LEADERSHIP_PRIVATE_KEY, provider);
    if (adminWallet.address.toLowerCase() !== String(leadershipWallet).toLowerCase()) {
      throw new Error(
        `LEADERSHIP_PRIVATE_KEY address ${adminWallet.address} does not match on-chain leadershipWallet ${leadershipWallet}`,
      );
    }

    // Pull any contract-held protocol balance into the wallet before reading ERC20 balances.
    await this.withdrawProtocolBalances(adminWallet);

    const eligibleUsers = await User.find({
      rank: { $in: [...LEADERSHIP_ELIGIBLE_RANKS] },
    });

    if (eligibleUsers.length === 0) {
      console.log('No users with leadership shares — skipping payouts.');
      return [];
    }

    const tokenPools = await this.loadStablecoinPools(String(leadershipWallet));
    tokenPools.forEach((p) =>
      console.log(
        `Live Leadership Pool Balance: $${ethers.formatUnits(p.rawBalance, p.decimals)} ${p.symbol} (raw ${p.rawBalance})`,
      ),
    );

    const zero = BigInt(0);
    const totalRaw = tokenPools.reduce((sum, p) => sum + p.rawBalance, zero);
    if (totalRaw === zero) {
      console.log('Leadership pool is empty — nothing to distribute this month.');
      return [];
    }

    let totalShares = 0;
    const userShares = eligibleUsers.map((u) => {
      const shares = getLeadershipShares(u.rank);
      totalShares += shares;
      return {
        username: u.username,
        walletAddress: u.walletAddress.toLowerCase(),
        rank: u.rank,
        shares,
      };
    });

    console.log(
      `Eligible leaders: ${userShares.length}, total shares: ${totalShares}`,
      userShares.map((u) => `${u.username}=${u.shares}`).join(', '),
    );

    if (totalShares === 0) {
      console.log('No users with leadership shares — skipping payouts.');
      return [];
    }

    const currentMonth = new Date().toISOString().slice(0, 7);
    const payoutsSaved = [];
    const decimals = tokenPools[0].decimals;
    let remainingShares = totalShares;

    for (const userShare of userShares) {
      if (userShare.shares <= 0) continue;

      const existing = await Payout.findOne({ username: userShare.username, month: currentMonth });
      if (existing) {
        console.log(`Skipping ${userShare.username} — already paid for ${currentMonth}`);
        // Already-paid users still consume their share weight from the remaining
        // denominator so unpaid peers keep a fair claim on what's left.
        remainingShares -= userShare.shares;
        continue;
      }

      if (remainingShares <= 0) break;

      const remainingRaw = tokenPools.reduce((sum, p) => sum + p.rawBalance, zero);
      if (remainingRaw <= zero) {
        console.log('Leadership pool depleted mid-run — stopping.');
        break;
      }

      // Pro-rata of whatever is still left; last unpaid user absorbs integer dust.
      const owedRaw = (remainingRaw * BigInt(userShare.shares)) / BigInt(remainingShares);
      if (owedRaw <= zero) {
        remainingShares -= userShare.shares;
        continue;
      }

      const slices = this.planUsdtFirst(tokenPools, owedRaw);
      if (!slices || slices.length === 0) {
        console.log(
          `Skipping ${userShare.username} — insufficient remaining pool for owed ${ethers.formatUnits(owedRaw, decimals)}`,
        );
        remainingShares -= userShare.shares;
        continue;
      }

      const breakdown: IPayoutBreakdownEntry[] = [];
      let totalUSD = 0;

      try {
        console.log(
          `Paying ${userShare.username} $${ethers.formatUnits(owedRaw, decimals)} ` +
            `via ${slices.map((s) => s.pool.symbol).join('→')}...`,
        );

        for (const { pool, amountRaw } of slices) {
          const amount = Number(ethers.formatUnits(amountRaw, pool.decimals));
          const erc20WithSigner = getErc20(pool.address).connect(adminWallet) as ethers.Contract;
          const tx = await erc20WithSigner.transfer(userShare.walletAddress, amountRaw);
          console.log(`  ${pool.symbol} ${amount} tx: ${tx.hash}`);
          await tx.wait(1);

          breakdown.push({
            symbol: pool.symbol,
            tokenAddress: pool.address,
            amount,
            txHash: tx.hash,
            status: 'PAID',
          });
          totalUSD += amount;
        }

        this.applySlices(slices);
      } catch (e: any) {
        console.error(`Failed leadership payout to ${userShare.walletAddress}:`, e.message);
        const paidSymbols = new Set(breakdown.map((b) => b.symbol));
        for (const { pool, amountRaw } of slices) {
          if (paidSymbols.has(pool.symbol)) continue;
          breakdown.push({
            symbol: pool.symbol,
            tokenAddress: pool.address,
            amount: Number(ethers.formatUnits(amountRaw, pool.decimals)),
            status: 'FAILED',
          });
        }

        const refreshed = await this.loadStablecoinPools(String(leadershipWallet));
        for (const pool of tokenPools) {
          const live = refreshed.find((r) => r.symbol === pool.symbol);
          if (live) pool.rawBalance = live.rawBalance;
        }
      }

      remainingShares -= userShare.shares;

      if (breakdown.length === 0) continue;

      const paidEntry = breakdown.find((b) => b.status === 'PAID');
      const newPayout = await Payout.create({
        walletAddress: userShare.walletAddress,
        username: userShare.username,
        rank: userShare.rank,
        amountUSDC: totalUSD,
        shares: userShare.shares,
        txHash: paidEntry?.txHash,
        breakdown,
        month: currentMonth,
        status: paidEntry ? 'PAID' : 'FAILED',
      });
      payoutsSaved.push(newPayout);

      if (paidEntry) {
        await NotificationService.createQuiet({
          walletAddress: userShare.walletAddress,
          type: 'LEADERSHIP_PAYOUT',
          title: 'Leadership Bonus deposited',
          sub: `$${totalUSD.toFixed(2)} auto-deposited for ${currentMonth} (${userShare.shares} share${userShare.shares === 1 ? '' : 's'} as ${userShare.rank}).`,
          link: 'VIEW NETWORK',
          meta: {
            month: currentMonth,
            shares: userShare.shares,
            amountUSDC: totalUSD,
            txHash: paidEntry.txHash,
            rank: userShare.rank,
            transfers: breakdown,
          },
        });
      }
    }

    console.log(
      `✅ Monthly Leadership Pool generated for ${currentMonth}. Created ${payoutsSaved.length} new payouts.`,
    );
    return payoutsSaved;
  }

  /** Every leadership payout a wallet has ever received (most recent first). */
  static async getPayoutHistory(walletAddress: string) {
    return Payout.find({ walletAddress: walletAddress.toLowerCase() }).sort({ createdAt: -1 });
  }
}
