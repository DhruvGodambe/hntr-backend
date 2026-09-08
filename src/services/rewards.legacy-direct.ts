/**
 * DISABLED: admin-triggered two-hop dispersal replaces auto-pay.
 *
 * Previous direct protocol-wallet → user ERC-20 transfer implementations.
 * Not imported anywhere — kept for easy restore. Live path is RewardsService
 * two-hop (protocol → burner → users) in rewards.service.ts.
 */
import User, { IUser } from '../models/User';
import Payout, { IPayoutBreakdownEntry } from '../models/Payout';
import AchievementBonus from '../models/AchievementBonus';
import { ethers } from 'ethers';
import {
  hntrContract,
  contractABI,
  provider,
  getErc20,
  getContractAmountDecimals,
  CONTRACT_ADDRESS,
} from './contract.service';
import { ENV } from '../config/env';
import {
  getLeadershipShares,
  LEADERSHIP_ELIGIBLE_RANKS,
} from '../constants';
import { NotificationService } from './notification.service';

type StablecoinPool = {
  symbol: 'USDT' | 'USDC';
  address: string;
  decimals: number;
  rawBalance: bigint;
};

type TokenSlice = { pool: StablecoinPool; amountRaw: bigint };

function planUsdtFirst(pools: StablecoinPool[], owedRaw: bigint): TokenSlice[] | null {
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

function applySlices(slices: TokenSlice[]) {
  for (const { pool, amountRaw } of slices) {
    pool.rawBalance -= amountRaw;
  }
}

async function loadStablecoinPools(walletAddress: string): Promise<StablecoinPool[]> {
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

async function withdrawProtocolBalances(walletSigner: ethers.Wallet) {
  const membershipWithSigner = new ethers.Contract(CONTRACT_ADDRESS, contractABI, walletSigner);
  const [usdtAddress, usdcAddress] = await Promise.all([
    hntrContract.usdt(),
    hntrContract.usdc(),
  ]);

  for (const [symbol, tokenAddress] of [
    ['USDT', usdtAddress],
    ['USDC', usdcAddress],
  ] as const) {
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

/** @deprecated Direct achievement→user transfers. Not called. */
export async function legacyDirectDisbursePendingAchievementBonuses() {
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

  await withdrawProtocolBalances(adminWallet);

  const pending = await AchievementBonus.find({ status: 'PENDING' }).sort({ createdAt: 1 });
  if (pending.length === 0) {
    console.log('No pending achievement bonuses to disburse.');
    return [];
  }

  const tokenPools = await loadStablecoinPools(String(achievementWallet));
  const paidOut = [];
  const zero = BigInt(0);

  for (const bonus of pending) {
    const precision = Math.min(tokenPools[0]?.decimals ?? 6, 8);
    const amountRaw = ethers.parseUnits(bonus.amountUSD.toFixed(precision), tokenPools[0].decimals);
    if (amountRaw <= zero) continue;

    const slices = planUsdtFirst(tokenPools, amountRaw);
    if (!slices || slices.length === 0) continue;

    const transferMeta: { symbol: string; amount: number; txHash: string }[] = [];

    try {
      for (const { pool, amountRaw: sliceRaw } of slices) {
        const amount = Number(ethers.formatUnits(sliceRaw, pool.decimals));
        const erc20WithSigner = getErc20(pool.address).connect(adminWallet) as ethers.Contract;
        const tx = await erc20WithSigner.transfer(bonus.walletAddress, sliceRaw);
        await tx.wait(1);
        transferMeta.push({ symbol: pool.symbol, amount, txHash: tx.hash });
      }

      applySlices(slices);

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
    } catch (e: any) {
      console.error(`Failed to pay achievement bonus to ${bonus.walletAddress}:`, e.message);
      const refreshed = await loadStablecoinPools(String(achievementWallet));
      for (const pool of tokenPools) {
        const live = refreshed.find((r) => r.symbol === pool.symbol);
        if (live) pool.rawBalance = live.rawBalance;
      }
    }
  }

  return paidOut;
}

/** @deprecated Direct leadership→user transfers. Not called. */
export async function legacyDirectCalculateMonthlyLeadershipPool() {
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

  await withdrawProtocolBalances(adminWallet);

  const eligibleUsers = await User.find({
    rank: { $in: [...LEADERSHIP_ELIGIBLE_RANKS] },
  });

  if (eligibleUsers.length === 0) return [];

  const tokenPools = await loadStablecoinPools(String(leadershipWallet));
  const zero = BigInt(0);
  const totalRaw = tokenPools.reduce((sum, p) => sum + p.rawBalance, zero);
  if (totalRaw === zero) return [];

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

  if (totalShares === 0) return [];

  const currentMonth = new Date().toISOString().slice(0, 7);
  const payoutsSaved = [];
  const decimals = tokenPools[0].decimals;
  let remainingShares = totalShares;

  for (const userShare of userShares) {
    if (userShare.shares <= 0) continue;

    const existing = await Payout.findOne({ username: userShare.username, month: currentMonth });
    if (existing) {
      remainingShares -= userShare.shares;
      continue;
    }

    if (remainingShares <= 0) break;

    const remainingRaw = tokenPools.reduce((sum, p) => sum + p.rawBalance, zero);
    if (remainingRaw <= zero) break;

    const owedRaw = (remainingRaw * BigInt(userShare.shares)) / BigInt(remainingShares);
    if (owedRaw <= zero) {
      remainingShares -= userShare.shares;
      continue;
    }

    const slices = planUsdtFirst(tokenPools, owedRaw);
    if (!slices || slices.length === 0) {
      remainingShares -= userShare.shares;
      continue;
    }

    const breakdown: IPayoutBreakdownEntry[] = [];
    let totalUSD = 0;

    try {
      for (const { pool, amountRaw } of slices) {
        const amount = Number(ethers.formatUnits(amountRaw, pool.decimals));
        const erc20WithSigner = getErc20(pool.address).connect(adminWallet) as ethers.Contract;
        const tx = await erc20WithSigner.transfer(userShare.walletAddress, amountRaw);
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

      applySlices(slices);
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

      const refreshed = await loadStablecoinPools(String(leadershipWallet));
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

  return payoutsSaved;
}

// Silence unused import warnings for types kept for fidelity with the old file.
void (null as unknown as IUser);
