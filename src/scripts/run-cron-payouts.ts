/**
 * Manually run achievement + leadership payouts and print diagnostics.
 *
 *   npx tsx src/scripts/run-cron-payouts.ts
 */
import mongoose from 'mongoose';
import { ethers } from 'ethers';
import { connectDB } from '../config/db';
import { ENV } from '../config/env';
import User from '../models/User';
import Payout from '../models/Payout';
import AchievementBonus from '../models/AchievementBonus';
import { RewardsService } from '../services/rewards.service';
import { runMonthlyLeadershipPayout } from '../jobs/leadership-cron';
import { hntrContract, provider, getErc20, getContractAmountDecimals } from '../services/contract.service';
import { LEADERSHIP_ELIGIBLE_RANKS, getLeadershipShares } from '../constants';

async function diagnose() {
  const [achievementWallet, leadershipWallet, usdtAddress, usdcAddress, amountDecimals] =
    await Promise.all([
      hntrContract.achievementWallet(),
      hntrContract.leadershipWallet(),
      hntrContract.usdt(),
      hntrContract.usdc(),
      getContractAmountDecimals(),
    ]);

  const achievementKey = ENV.ACHIEVEMENT_WALLET_PRIVATE_KEY
    ? new ethers.Wallet(ENV.ACHIEVEMENT_WALLET_PRIVATE_KEY).address.toLowerCase()
    : null;
  const leadershipKey = ENV.LEADERSHIP_PRIVATE_KEY
    ? new ethers.Wallet(ENV.LEADERSHIP_PRIVATE_KEY).address.toLowerCase()
    : null;

  const usdt = getErc20(String(usdtAddress));
  const usdc = getErc20(String(usdcAddress));

  const [
    achUsdt,
    achUsdc,
    leadUsdt,
    leadUsdc,
    achEth,
    leadEth,
    achProtoUsdt,
    achProtoUsdc,
    leadProtoUsdt,
    leadProtoUsdc,
  ] = await Promise.all([
    usdt.balanceOf(achievementWallet),
    usdc.balanceOf(achievementWallet),
    usdt.balanceOf(leadershipWallet),
    usdc.balanceOf(leadershipWallet),
    provider.getBalance(String(achievementWallet)),
    provider.getBalance(String(leadershipWallet)),
    hntrContract.protocolBalances(achievementWallet, usdtAddress),
    hntrContract.protocolBalances(achievementWallet, usdcAddress),
    hntrContract.protocolBalances(leadershipWallet, usdtAddress),
    hntrContract.protocolBalances(leadershipWallet, usdcAddress),
  ]);

  const pending = await AchievementBonus.find({ status: 'PENDING' }).sort({ createdAt: 1 }).lean();
  const eligible = await User.find({ rank: { $in: [...LEADERSHIP_ELIGIBLE_RANKS] } })
    .select('username walletAddress rank')
    .lean();
  const month = new Date().toISOString().slice(0, 7);
  const existingPayouts = await Payout.find({ month }).lean();

  console.log(
    JSON.stringify(
      {
        contract: ENV.CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS,
        amountDecimals,
        achievement: {
          onChain: String(achievementWallet).toLowerCase(),
          envKey: achievementKey,
          keyMatch: achievementKey === String(achievementWallet).toLowerCase(),
          eth: Number(ethers.formatEther(achEth)),
          erc20: {
            USDT: Number(ethers.formatUnits(achUsdt, amountDecimals)),
            USDC: Number(ethers.formatUnits(achUsdc, amountDecimals)),
          },
          protocolBalances: {
            USDT: Number(ethers.formatUnits(achProtoUsdt, amountDecimals)),
            USDC: Number(ethers.formatUnits(achProtoUsdc, amountDecimals)),
          },
          pendingBonuses: pending.map((b) => ({
            username: b.username,
            rank: b.rank,
            amountUSD: b.amountUSD,
            wallet: b.walletAddress,
          })),
        },
        leadership: {
          onChain: String(leadershipWallet).toLowerCase(),
          envKey: leadershipKey,
          keyMatch: leadershipKey === String(leadershipWallet).toLowerCase(),
          eth: Number(ethers.formatEther(leadEth)),
          erc20: {
            USDT: Number(ethers.formatUnits(leadUsdt, amountDecimals)),
            USDC: Number(ethers.formatUnits(leadUsdc, amountDecimals)),
          },
          protocolBalances: {
            USDT: Number(ethers.formatUnits(leadProtoUsdt, amountDecimals)),
            USDC: Number(ethers.formatUnits(leadProtoUsdc, amountDecimals)),
          },
          eligibleUsers: eligible.map((u) => ({
            username: u.username,
            rank: u.rank,
            shares: getLeadershipShares(u.rank),
            wallet: u.walletAddress,
          })),
          existingPayoutsThisMonth: existingPayouts.map((p) => ({
            username: p.username,
            status: p.status,
            amountUSDC: p.amountUSDC,
          })),
        },
      },
      null,
      2,
    ),
  );
}

async function main() {
  await connectDB();
  console.log('\n=== DIAGNOSTICS ===');
  await diagnose();

  console.log('\n=== RUNNING ACHIEVEMENT DISBURSEMENT ===');
  try {
    const paid = await RewardsService.disbursePendingAchievementBonuses();
    console.log(`Achievement result: paid ${paid.length}`);
    for (const p of paid) {
      console.log(`  • ${p.username}: $${p.amountUSD} (${p.rank}) tx=${p.txHash}`);
    }
  } catch (e: any) {
    console.error('Achievement FAILED:', e.message || e);
  }

  console.log('\n=== RUNNING LEADERSHIP PAYOUT ===');
  try {
    const result = await runMonthlyLeadershipPayout();
    console.log(
      `Leadership result: created=${result.payouts.length} paid=${result.paid} failed=${result.failed} month=${result.month}`,
    );
  } catch (e: any) {
    console.error('Leadership FAILED:', e.message || e);
  }

  await mongoose.connection.close();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.connection.close();
  } catch {
    // ignore
  }
  process.exit(1);
});
