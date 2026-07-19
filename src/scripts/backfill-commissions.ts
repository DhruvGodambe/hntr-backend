import mongoose from 'mongoose';
import { ethers } from 'ethers';
import { connectDB } from '../config/db';
import User from '../models/User';
import Transaction from '../models/Transaction';
import PointsLedger from '../models/PointsLedger';
import { PointsService } from '../services/points.service';
import { CONTRACT_ADDRESS, contractABI, getContractAmountDecimals } from '../services/contract.service';
import { getLogsViaEtherscan } from '../services/etherscan.service';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';

const iface = new ethers.Interface(contractABI);
const commissionTopic = ethers.id('CommissionEarned(address,uint256,uint256,uint8,address)');

async function backfillCommissions() {
  try {
    await connectDB();

    if (!ENV.ETHERSCAN_API_KEY) {
      logger.error('ETHERSCAN_API_KEY is not set.');
      await mongoose.disconnect();
      process.exit(1);
    }

    const fromBlock = ENV.CONTRACT_DEPLOY_BLOCK || 0;
    logger.info(`Scanning from block ${fromBlock} via Etherscan for CommissionEarned events...`);

    const logs = await getLogsViaEtherscan({
      address: CONTRACT_ADDRESS,
      topics: [commissionTopic, undefined],
      fromBlock,
    });

    logger.info(`Found ${logs.length} CommissionEarned events on-chain`);

    const amountDecimals = await getContractAmountDecimals();
    let missing = 0;
    let alreadyStored = 0;
    let fixed = 0;

    for (const log of logs) {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed || parsed.name !== 'CommissionEarned') continue;

      const [user, liquidAmount, lockedAmount, level, token] = parsed.args;
      const walletAddress = user.toLowerCase();
      const txHash = log.transactionHash.toLowerCase();
      const tokenAddress = token.toLowerCase();
      const levelNum = Number(level);

      const existing = await Transaction.findOne({
        txHash,
        walletAddress,
        type: 'COMMISSION_EARNED',
        token: tokenAddress,
        level: levelNum,
      });

      if (existing) {
        alreadyStored++;
        continue;
      }

      missing++;
      const liquid = Number(ethers.formatUnits(liquidAmount.toString(), amountDecimals));
      const locked = Number(ethers.formatUnits(lockedAmount.toString(), amountDecimals));
      const total = liquid + locked;

      logger.info(
        `Missing record: ${walletAddress} tx=${txHash} level=${levelNum} token=${tokenAddress} liquid=${liquid} locked=${locked}`,
      );

      await Transaction.create({
        txHash,
        walletAddress,
        type: 'COMMISSION_EARNED',
        token: tokenAddress,
        amount: total,
        liquidAmount: liquid,
        lockedAmount: locked,
        level: levelNum,
        status: 'CONFIRMED',
        timestamp: new Date(),
      });

      try {
        await PointsService.awardPoints(walletAddress, 'COMMISSION_EARNED', total, txHash, {
          level: levelNum,
          token: tokenAddress,
        });
      } catch (pointsErr: any) {
        logger.error(`Failed to award points for ${txHash}: ${pointsErr.message}`);
      }

      fixed++;
    }

    logger.info(`Done. On-chain events: ${logs.length}, already stored: ${alreadyStored}, missing: ${missing}, fixed: ${fixed}`);

    if (fixed > 0) {
      logger.info('Recalculating points for all affected wallets...');
      const affectedWallets = await Transaction.distinct('walletAddress', { type: 'COMMISSION_EARNED' });
      for (const wallet of affectedWallets) {
        try {
          await PointsService.recalculatePoints(wallet);
        } catch (err: any) {
          logger.error(`Failed to recalculate points for ${wallet}: ${err.message}`);
        }
      }
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (error: any) {
    logger.error('Backfill failed:', error.message);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
}

backfillCommissions();
