import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import SyncState from '../models/SyncState';
import Transaction from '../models/Transaction';
import User from '../models/User';
import { provider } from '../services/contract.service';
import { logger } from '../utils/logger';

async function diagnostic() {
  try {
    await connectDB();

    const currentBlock = await provider.getBlockNumber();
    const syncState = await SyncState.findOne({ key: 'blockchain-listener' }).lean();
    const lastProcessed = syncState?.lastProcessedBlock || 0;

    const txCount = await Transaction.countDocuments();
    const commissionCount = await Transaction.countDocuments({ type: 'COMMISSION_EARNED' });
    const purchaseCount = await Transaction.countDocuments({ type: 'PURCHASE' });
    const upgradeCount = await Transaction.countDocuments({ type: 'UPGRADE' });
    const userCount = await User.countDocuments();

    const latestTx = await Transaction.findOne().sort({ timestamp: -1 }).lean();
    const earliestTx = await Transaction.findOne().sort({ timestamp: 1 }).lean();

    logger.info(`Current block: ${currentBlock}`);
    logger.info(`Last processed block (listener): ${lastProcessed}`);
    logger.info(`Gap: ${currentBlock - lastProcessed} blocks`);
    logger.info(`Users: ${userCount}`);
    logger.info(`Total transactions: ${txCount}`);
    logger.info(`  PURCHASE: ${purchaseCount}`);
    logger.info(`  UPGRADE: ${upgradeCount}`);
    logger.info(`  COMMISSION_EARNED: ${commissionCount}`);
    logger.info(`Latest transaction: ${latestTx?.txHash || 'none'} at ${latestTx?.timestamp || 'n/a'}`);
    logger.info(`Earliest transaction: ${earliestTx?.txHash || 'none'} at ${earliestTx?.timestamp || 'n/a'}`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (error: any) {
    logger.error('Diagnostic failed:', error.message);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
}

diagnostic();
