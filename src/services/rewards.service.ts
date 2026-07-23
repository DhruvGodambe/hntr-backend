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

export class RewardsService {
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
   * On rank upgrade, create PENDING AchievementBonus rows for every newly crossed
   * rank (unique per wallet+rank). Does not pay — the daily cron does that when
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
   * Pays PENDING achievement bonuses oldest-first when achievementWallet holds
   * at least the full USD amount in USDT or USDC (single-token, no partials).
   */
  static async disbursePendingAchievementBonuses() {
    if (!ENV.ACHIEVEMENT_WALLET_PRIVATE_KEY) {
      throw new Error(
        'ACHIEVEMENT_WALLET_PRIVATE_KEY not found in environment for automated payouts!',
      );
    }

    const [usdtAddress, usdcAddress, achievementWallet] = await Promise.all([
      hntrContract.usdt(),
      hntrContract.usdc(),
      hntrContract.achievementWallet(),
    ]);

    const adminWallet = new ethers.Wallet(ENV.ACHIEVEMENT_WALLET_PRIVATE_KEY, provider);
    if (adminWallet.address.toLowerCase() !== String(achievementWallet).toLowerCase()) {
      throw new Error(
        `ACHIEVEMENT_WALLET_PRIVATE_KEY address ${adminWallet.address} does not match on-chain achievementWallet ${achievementWallet}`,
      );
    }

    type TokenPool = {
      symbol: string;
      address: string;
      decimals: number;
      rawBalance: bigint;
      balance: number;
    };

    const amountDecimals = await getContractAmountDecimals();

    const pending = await AchievementBonus.find({ status: 'PENDING' }).sort({ createdAt: 1 });
    if (pending.length === 0) {
      console.log('No pending achievement bonuses to disburse.');
      return [];
    }

    const tokenPools: TokenPool[] = await Promise.all(
      (
        [
          { symbol: 'USDT', address: usdtAddress },
          { symbol: 'USDC', address: usdcAddress },
        ] as const
      ).map(async ({ symbol, address }) => {
        const erc20 = getErc20(address);
        const rawBalance = (await erc20.balanceOf(achievementWallet)) as bigint;
        return {
          symbol,
          address,
          decimals: amountDecimals,
          rawBalance,
          balance: Number(ethers.formatUnits(rawBalance, amountDecimals)),
        };
      }),
    );

    tokenPools.forEach((p) =>
      console.log(`Live Achievement Wallet Balance: $${p.balance} ${p.symbol}`),
    );

    const paidOut = [];
    const zero = BigInt(0);

    for (const bonus of pending) {
      // Prefer the first token that can cover the full amount (USDT then USDC).
      let fundingPool: TokenPool | undefined;
      for (const pool of tokenPools) {
        if (pool.balance + 1e-9 >= bonus.amountUSD) {
          fundingPool = pool;
          break;
        }
      }

      if (!fundingPool) {
        console.log(
          `Skipping ${bonus.username} ${bonus.rank} $${bonus.amountUSD} — achievement wallet underfunded`,
        );
        continue;
      }

      const precision = Math.min(fundingPool.decimals, 8);
      const amountRaw = ethers.parseUnits(bonus.amountUSD.toFixed(precision), fundingPool.decimals);

      if (amountRaw > fundingPool.rawBalance) {
        console.log(
          `Skipping ${bonus.username} ${bonus.rank} — raw balance too low after precision adjust`,
        );
        continue;
      }

      try {
        console.log(
          `Paying achievement bonus $${bonus.amountUSD} ${fundingPool.symbol} to ${bonus.walletAddress} (${bonus.rank})...`,
        );
        const erc20WithSigner = getErc20(fundingPool.address).connect(adminWallet) as ethers.Contract;
        const tx = await erc20WithSigner.transfer(bonus.walletAddress, amountRaw);
        console.log(`Transaction sent! Hash: ${tx.hash}`);
        await tx.wait(1);

        bonus.status = 'PAID';
        bonus.token = fundingPool.symbol;
        bonus.tokenAddress = fundingPool.address;
        bonus.txHash = tx.hash;
        bonus.paidAt = new Date();
        await bonus.save();
        paidOut.push(bonus);

        // Keep in-memory balances in sync for subsequent payouts in this run.
        fundingPool.rawBalance = fundingPool.rawBalance - amountRaw;
        fundingPool.balance = Number(
          ethers.formatUnits(fundingPool.rawBalance, fundingPool.decimals),
        );

        await NotificationService.createQuiet({
          walletAddress: bonus.walletAddress,
          type: 'ACHIEVEMENT_PAYOUT',
          title: 'Rank Bonus deposited',
          sub: `$${bonus.amountUSD.toFixed(2)} auto-deposited for reaching ${bonus.rank}.`,
          link: 'VIEW NETWORK',
          meta: {
            rank: bonus.rank,
            amountUSD: bonus.amountUSD,
            txHash: tx.hash,
            token: fundingPool.symbol,
          },
        });

        console.log(`Paid ${bonus.username}: $${bonus.amountUSD} for ${bonus.rank}`);
      } catch (e: any) {
        console.error(
          `Failed to pay achievement bonus to ${bonus.walletAddress}:`,
          e.message,
        );
        // Keep PENDING so the next cron/manual run retries (e.g. RPC blips, gas).
        // Only mark FAILED when we intentionally want to stop retries.
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
        ` Paid oldest-first in full (no partials) by the daily cron.`;
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
   * Calculates the monthly leadership pool distribution based on live on-chain balances,
   * and pays each eligible user's share directly to their wallet (a real ERC20
   * `transfer`, not a claimable contract balance - leadership bonus is auto-deposited,
   * no "claim" step needed).
   *
   * Share weights come from LEADERSHIP_SHARES (Hunter=1, Elite=3, Master=7, Legend=15).
   * Amounts are computed with BigInt against the raw token balance so dust stays in the
   * pool wallet rather than over-drawing.
   */
  static async calculateMonthlyLeadershipPool() {
    const [usdtAddress, usdcAddress, leadershipWallet] = await Promise.all([
      hntrContract.usdt(),
      hntrContract.usdc(),
      hntrContract.leadershipWallet(),
    ]);

    if (!ENV.LEADERSHIP_PRIVATE_KEY) {
      throw new Error('LEADERSHIP_PRIVATE_KEY not found in environment for automated payouts!');
    }

    const adminWallet = new ethers.Wallet(ENV.LEADERSHIP_PRIVATE_KEY, provider);
    if (adminWallet.address.toLowerCase() !== String(leadershipWallet).toLowerCase()) {
      throw new Error(
        `LEADERSHIP_PRIVATE_KEY address ${adminWallet.address} does not match on-chain leadershipWallet ${leadershipWallet}`,
      );
    }

    const eligibleUsers = await User.find({
      rank: { $in: [...LEADERSHIP_ELIGIBLE_RANKS] },
    });

    if (eligibleUsers.length === 0) {
      console.log('No users with leadership shares — skipping payouts.');
      return [];
    }

    const amountDecimals = await getContractAmountDecimals();

    const tokenPools = await Promise.all(
      (
        [
          { symbol: 'USDT', address: usdtAddress },
          { symbol: 'USDC', address: usdcAddress },
        ] as const
      ).map(async ({ symbol, address }) => {
        const erc20 = getErc20(address);
        const rawBalance = (await erc20.balanceOf(leadershipWallet)) as bigint;
        return {
          symbol,
          address,
          decimals: amountDecimals,
          rawBalance,
          balance: Number(ethers.formatUnits(rawBalance, amountDecimals)),
        };
      }),
    );

    tokenPools.forEach((p) =>
      console.log(`Live Leadership Pool Balance: $${p.balance} ${p.symbol} (raw ${p.rawBalance})`),
    );

    const zero = BigInt(0);
    const poolEmpty = tokenPools.every((p) => p.rawBalance === zero);
    if (poolEmpty) {
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

    for (const userShare of userShares) {
      if (userShare.shares <= 0) continue;

      const existing = await Payout.findOne({ username: userShare.username, month: currentMonth });
      if (existing) {
        console.log(`Skipping ${userShare.username} — already paid for ${currentMonth}`);
        continue;
      }

      const breakdown: IPayoutBreakdownEntry[] = [];
      let totalUSD = 0;

      for (const pool of tokenPools) {
        if (pool.rawBalance <= zero) continue;

        // Integer pro-rata: amount = rawBalance * userShares / totalShares
        const amountRaw = (pool.rawBalance * BigInt(userShare.shares)) / BigInt(totalShares);
        if (amountRaw <= zero) continue;

        const amount = Number(ethers.formatUnits(amountRaw, pool.decimals));

        try {
          console.log(
            `Executing live transfer of ${amount} ${pool.symbol} (${amountRaw} raw) to ${userShare.walletAddress}...`,
          );
          const erc20WithSigner = getErc20(pool.address).connect(adminWallet) as ethers.Contract;
          const tx = await erc20WithSigner.transfer(userShare.walletAddress, amountRaw);
          console.log(`Transaction sent! Hash: ${tx.hash}`);
          await tx.wait(1);
          console.log(`Transaction confirmed for ${userShare.username} (${pool.symbol}).`);

          breakdown.push({
            symbol: pool.symbol,
            tokenAddress: pool.address,
            amount,
            txHash: tx.hash,
            status: 'PAID',
          });
          totalUSD += amount;
        } catch (e: any) {
          console.error(`Failed to transfer ${pool.symbol} to ${userShare.walletAddress}:`, e.message);
          breakdown.push({
            symbol: pool.symbol,
            tokenAddress: pool.address,
            amount,
            status: 'FAILED',
          });
        }
      }

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
