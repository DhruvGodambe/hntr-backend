/**
 * Inspect pending achievement bonuses + whether ACHIEVEMENT key matches on-chain wallet.
 *
 *   npx tsx src/scripts/inspect-achievement-pending.ts
 */
import mongoose from 'mongoose';
import { ethers } from 'ethers';
import { connectDB } from '../config/db';
import { ENV } from '../config/env';
import AchievementBonus from '../models/AchievementBonus';
import { hntrContract, provider, getErc20, getContractAmountDecimals } from '../services/contract.service';

async function main() {
  await connectDB();

  const [achievementWallet, burnerAddr, usdtAddress, usdcAddress, amountDecimals] = await Promise.all([
    hntrContract.rankWallet(),
    hntrContract.burnerWallet(),
    hntrContract.usdt(),
    hntrContract.usdc(),
    getContractAmountDecimals(),
  ]);

  const usdt = getErc20(String(usdtAddress));
  const usdc = getErc20(String(usdcAddress));
  const [usdtRaw, usdcRaw] = await Promise.all([
    usdt.balanceOf(achievementWallet),
    usdc.balanceOf(achievementWallet),
  ]);

  const pending = await AchievementBonus.find({ status: 'PENDING' })
    .sort({ createdAt: 1 })
    .lean();
  const deba07 = await AchievementBonus.find({ username: 'deba07' }).sort({ createdAt: 1 }).lean();

  console.log(
    JSON.stringify(
      {
        cronSchedule: '30 0 * * * (00:30 UTC daily ≈ 06:00 IST)',
        note: 'node-cron does NOT backfill missed runs — backend must be running at that time',
        rankWallet: String(achievementWallet).toLowerCase(),
        burnerWallet: String(burnerAddr).toLowerCase(),
        fundingNote: 'admin connects the rank wallet and transfers USDT/USDC to the burner before Distribute',
        amountDecimals,
        balances: {
          USDT: Number(ethers.formatUnits(usdtRaw, amountDecimals)),
          USDC: Number(ethers.formatUnits(usdcRaw, amountDecimals)),
        },
        pendingCount: pending.length,
        pendingOldestFirst: pending.map((b) => ({
          username: b.username,
          rank: b.rank,
          amountUSD: b.amountUSD,
          walletAddress: b.walletAddress,
          status: b.status,
          createdAt: b.createdAt,
        })),
        deba07Bonuses: deba07.map((b) => ({
          rank: b.rank,
          amountUSD: b.amountUSD,
          status: b.status,
          txHash: b.txHash,
          paidAt: b.paidAt,
          createdAt: b.createdAt,
        })),
      },
      null,
      2,
    ),
  );

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
