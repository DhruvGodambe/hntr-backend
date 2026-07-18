import mongoose from 'mongoose';
import { ethers } from 'ethers';
import { connectDB } from '../config/db';
import Transaction from '../models/Transaction';
import { CONTRACT_ADDRESS, contractABI } from '../services/contract.service';
import { getLogsViaEtherscan } from '../services/etherscan.service';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';

const iface = new ethers.Interface(contractABI);
const commissionTopic = ethers.id('CommissionEarned(address,uint256,uint256,uint8,address)');

async function checkChainCommissions() {
  try {
    await connectDB();

    if (!ENV.ETHERSCAN_API_KEY) {
      logger.error('ETHERSCAN_API_KEY is not set.');
      await mongoose.disconnect();
      process.exit(1);
    }

    const fromBlock = ENV.CONTRACT_DEPLOY_BLOCK || 0;
    logger.info(`Read-only Etherscan scan from block ${fromBlock} for CommissionEarned events`);

    const logs = await getLogsViaEtherscan({
      address: CONTRACT_ADDRESS,
      topics: [commissionTopic, undefined],
      fromBlock,
    });

    logger.info(`Found ${logs.length} CommissionEarned events on-chain`);

    let inDb = 0;
    let missing = 0;

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
        inDb++;
      } else {
        missing++;
        logger.info(
          `MISSING: wallet=${walletAddress} tx=${txHash} level=${levelNum} token=${tokenAddress} liquid=${liquidAmount} locked=${lockedAmount}`,
        );
      }
    }

    logger.info(`On-chain events: ${logs.length}, already in DB: ${inDb}, missing: ${missing}`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (error: any) {
    logger.error('Check failed:', error.message);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
}

checkChainCommissions();
