import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import User from '../models/User';
import Transaction from '../models/Transaction';
import PointsLedger from '../models/PointsLedger';
import { PointsService } from '../services/points.service';
import { logger } from '../utils/logger';

async function checkPoints() {
  const username = process.argv[2] || 'deba07';

  try {
    await connectDB();

    const user = await User.findOne({ username }).lean();
    if (!user) {
      logger.error(`User "${username}" not found in database.`);
      await mongoose.disconnect();
      process.exit(1);
    }

    logger.info(`Checking HNTR points for ${username} (${user.walletAddress})`);
    logger.info(`Current stored points: ${user.hntrPoints ?? 0}`);

    const transactions = await Transaction.find({
      walletAddress: user.walletAddress,
      status: { $in: ['CONFIRMED', 'PENDING'] },
    }).sort({ timestamp: -1 }).lean();

    logger.info(`Found ${transactions.length} transactions`);

    let expectedFromMembership = 0;
    let expectedFromCommission = 0;

    for (const tx of transactions) {
      switch (tx.type) {
        case 'PURCHASE':
        case 'UPGRADE': {
          const points = Math.round((tx.amount || 0) * 250);
          expectedFromMembership += points;
          logger.info(`  ${tx.type} ${tx.tier || ''}: $${tx.amount} -> ${points} pts`);
          break;
        }
        case 'COMMISSION_EARNED': {
          const commissionTotal = (tx.liquidAmount || 0) + (tx.lockedAmount || 0);
          const points = Math.round(commissionTotal * 10);
          expectedFromCommission += points;
          logger.info(`  COMMISSION_EARNED level ${tx.level}: $${commissionTotal} -> ${points} pts`);
          break;
        }
      }
    }

    const expectedTotal = expectedFromMembership + expectedFromCommission;
    logger.info(`Expected from membership: ${expectedFromMembership}`);
    logger.info(`Expected from commission: ${expectedFromCommission}`);
    logger.info(`Expected total: ${expectedTotal}`);
    logger.info(`Stored total: ${user.hntrPoints ?? 0}`);

    if ((user.hntrPoints ?? 0) !== expectedTotal) {
      logger.warn(`Mismatch detected. Recalculating...`);
      const recalculated = await PointsService.recalculatePoints(user.walletAddress);
      logger.info(`Recalculated points: ${recalculated}`);
    } else {
      logger.info(`Points match expected value.`);
    }

    const ledgerCount = await PointsLedger.countDocuments({ walletAddress: user.walletAddress });
    logger.info(`Ledger entries: ${ledgerCount}`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (error: any) {
    logger.error('Check points failed:', error.message);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
}

checkPoints();
