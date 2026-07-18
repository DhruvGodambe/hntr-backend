import User from '../models/User';
import Transaction from '../models/Transaction';
import PointsLedger, { PointsSource } from '../models/PointsLedger';
import { logger } from '../utils/logger';

// Points multipliers per USD value.
// POOL_DEPOSIT is defined but not yet awarded by any caller (kept commented out
// in the event listeners until pool deposits are integrated).
const MULTIPLIERS: Record<PointsSource, number> = {
  MEMBERSHIP_PURCHASE: 250,
  MEMBERSHIP_UPGRADE: 250,
  COMMISSION_EARNED: 10,
  POOL_DEPOSIT: 15,
};

export interface PointsSummary {
  walletAddress: string;
  hntrPoints: number;
}

export class PointsService {
  /**
   * Awards points to a wallet and records the ledger entry.
   * Idempotent: skips if a ledger entry for the same txHash + source already exists.
   */
  static async awardPoints(
    walletAddress: string,
    source: PointsSource,
    usdValue: number,
    txHash?: string,
  ): Promise<void> {
    const normalizedWallet = walletAddress.toLowerCase();

    if (txHash) {
      const existing = await PointsLedger.findOne({
        txHash: txHash.toLowerCase(),
        walletAddress: normalizedWallet,
        source,
      });
      if (existing) {
        logger.info(`Points already awarded for ${source} tx ${txHash} to ${normalizedWallet}`);
        return;
      }
    }

    const multiplier = MULTIPLIERS[source];
    if (!multiplier) {
      logger.warn(`No multiplier configured for points source ${source}`);
      return;
    }

    const points = Math.round(usdValue * multiplier);
    if (points <= 0) return;

    await PointsLedger.create({
      walletAddress: normalizedWallet,
      amount: points,
      source,
      usdValue,
      txHash: txHash ? txHash.toLowerCase() : undefined,
      timestamp: new Date(),
    });

    await User.findOneAndUpdate(
      { walletAddress: normalizedWallet },
      { $inc: { hntrPoints: points } },
      { upsert: false },
    );

    logger.info(
      `Awarded ${points} HNTR points to ${normalizedWallet} for ${source} (USD ${usdValue.toFixed(2)})`,
    );
  }

  /**
   * Recalculates points for a single wallet from the transaction history.
   * Useful for cron reconciliation or fixing a specific user.
   */
  static async recalculatePoints(walletAddress: string): Promise<number> {
    const normalizedWallet = walletAddress.toLowerCase();

    await PointsLedger.deleteMany({ walletAddress: normalizedWallet });

    const records = await Transaction.find({
      walletAddress: normalizedWallet,
      status: { $in: ['CONFIRMED', 'PENDING'] },
    }).lean();

    let totalPoints = 0;

    for (const record of records) {
      switch (record.type) {
        case 'PURCHASE': {
          const points = Math.round((record.amount || 0) * MULTIPLIERS.MEMBERSHIP_PURCHASE);
          if (points > 0) {
            await PointsLedger.create({
              walletAddress: normalizedWallet,
              amount: points,
              source: 'MEMBERSHIP_PURCHASE',
              usdValue: record.amount,
              txHash: record.txHash,
            });
            totalPoints += points;
          }
          break;
        }
        case 'UPGRADE': {
          const points = Math.round((record.amount || 0) * MULTIPLIERS.MEMBERSHIP_UPGRADE);
          if (points > 0) {
            await PointsLedger.create({
              walletAddress: normalizedWallet,
              amount: points,
              source: 'MEMBERSHIP_UPGRADE',
              usdValue: record.amount,
              txHash: record.txHash,
            });
            totalPoints += points;
          }
          break;
        }
        case 'COMMISSION_EARNED': {
          const commissionTotal = (record.liquidAmount || 0) + (record.lockedAmount || 0);
          const points = Math.round(commissionTotal * MULTIPLIERS.COMMISSION_EARNED);
          if (points > 0) {
            await PointsLedger.create({
              walletAddress: normalizedWallet,
              amount: points,
              source: 'COMMISSION_EARNED',
              usdValue: commissionTotal,
              txHash: record.txHash,
            });
            totalPoints += points;
          }
          break;
        }
      }
    }

    await User.findOneAndUpdate(
      { walletAddress: normalizedWallet },
      { $set: { hntrPoints: totalPoints } },
      { upsert: false },
    );

    logger.info(`Recalculated HNTR points for ${normalizedWallet}: ${totalPoints}`);
    return totalPoints;
  }

  /**
   * Recalculates points for every wallet. Intended for cron reconciliation.
   */
  static async recalculateAllPoints(): Promise<void> {
    const wallets = await User.distinct('walletAddress');
    logger.info(`Recalculating HNTR points for ${wallets.length} wallets`);

    for (const wallet of wallets) {
      try {
        await this.recalculatePoints(wallet);
      } catch (err: any) {
        logger.error(`Failed to recalculate points for ${wallet}: ${err.message}`);
      }
    }
  }

  /**
   * Returns the current points balance and recent ledger entries for a wallet.
   */
  static async getPointsSummary(
    walletAddress: string,
    ledgerLimit = 20,
  ): Promise<{ hntrPoints: number; ledger: any[] }> {
    const normalizedWallet = walletAddress.toLowerCase();
    const user = await User.findOne({ walletAddress: normalizedWallet }).lean();
    const ledger = await PointsLedger.find({ walletAddress: normalizedWallet })
      .sort({ timestamp: -1 })
      .limit(ledgerLimit)
      .lean();

    return {
      hntrPoints: user?.hntrPoints || 0,
      ledger,
    };
  }
}
