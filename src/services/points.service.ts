import User from '../models/User';
import Transaction from '../models/Transaction';
import PointsLedger, { PointsSource } from '../models/PointsLedger';
import { logger } from '../utils/logger';

// Points multipliers per USD value.
const MULTIPLIERS: Record<PointsSource, number> = {
  MEMBERSHIP_PURCHASE: 250,
  MEMBERSHIP_UPGRADE: 250,
  COMMISSION_EARNED: 10,
  POOL_DEPOSIT: 15,
};

type DesiredEntry = {
  entryKey: string;
  source: PointsSource;
  amount: number;
  usdValue: number;
  txHash?: string;
  level?: number;
  timestamp: Date;
};

export interface PointsSummary {
  walletAddress: string;
  hntrPoints: number;
}

/**
 * Serializes award + recalculate per wallet so cron reconciliation cannot race
 * the blockchain listener's awardPoints and trip the unique ledger index.
 */
const walletChains = new Map<string, Promise<unknown>>();

async function withWalletLock<T>(walletAddress: string, fn: () => Promise<T>): Promise<T> {
  const key = walletAddress.toLowerCase();
  const previous = walletChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => gate);
  walletChains.set(key, chained);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (walletChains.get(key) === chained) {
      walletChains.delete(key);
    }
  }
}

function isDuplicateKeyError(err: any): boolean {
  return err?.code === 11000 || err?.codeName === 'DuplicateKey';
}

function membershipEntryKey(source: PointsSource, txHash: string): string {
  return `${source}:${txHash.toLowerCase()}`;
}

function commissionEntryKey(txHash: string, level: number, token?: string): string {
  return `COMMISSION_EARNED:${txHash.toLowerCase()}:L${level}:${(token || '').toLowerCase()}`;
}

export class PointsService {
  /**
   * Awards points to a wallet and records the ledger entry.
   * Idempotent via unique entryKey upsert — only increments the user balance on insert.
   */
  static async awardPoints(
    walletAddress: string,
    source: PointsSource,
    usdValue: number,
    txHash?: string,
    extras?: { level?: number; token?: string },
  ): Promise<void> {
    const normalizedWallet = walletAddress.toLowerCase();
    const multiplier = MULTIPLIERS[source];
    if (!multiplier) {
      logger.warn(`No multiplier configured for points source ${source}`);
      return;
    }

    const points = Math.round(usdValue * multiplier);
    if (points <= 0) return;

    if (!txHash) {
      logger.warn(`awardPoints called without txHash for ${source} / ${normalizedWallet}; skipping`);
      return;
    }

    const normalizedHash = txHash.toLowerCase();
    const entryKey =
      source === 'COMMISSION_EARNED'
        ? commissionEntryKey(normalizedHash, extras?.level ?? 0, extras?.token)
        : membershipEntryKey(source, normalizedHash);

    await withWalletLock(normalizedWallet, async () => {
      try {
        const result = await PointsLedger.updateOne(
          { walletAddress: normalizedWallet, entryKey },
          {
            $setOnInsert: {
              walletAddress: normalizedWallet,
              entryKey,
              amount: points,
              source,
              usdValue,
              txHash: normalizedHash,
              level: extras?.level,
              timestamp: new Date(),
            },
          },
          { upsert: true },
        );

        if (result.upsertedCount === 1) {
          await User.findOneAndUpdate(
            { walletAddress: normalizedWallet },
            { $inc: { hntrPoints: points } },
            { upsert: false },
          );
          logger.info(
            `Awarded ${points} HNTR points to ${normalizedWallet} for ${source} (USD ${usdValue.toFixed(2)})`,
          );
        } else {
          logger.info(`Points already awarded for ${source} ${entryKey} to ${normalizedWallet}`);
        }
      } catch (err: any) {
        if (isDuplicateKeyError(err)) {
          logger.info(`Points already awarded (dup key) for ${entryKey} to ${normalizedWallet}`);
          return;
        }
        throw err;
      }
    });
  }

  /**
   * Rebuilds the ledger for a wallet from CONFIRMED transactions only.
   * Upserts desired rows, deletes orphans, then sets hntrPoints to the ledger sum.
   * Never delete-then-insert (that raced awardPoints and caused E11000).
   */
  static async recalculatePoints(walletAddress: string): Promise<number> {
    const normalizedWallet = walletAddress.toLowerCase();

    return withWalletLock(normalizedWallet, async () => {
      const records = await Transaction.find({
        walletAddress: normalizedWallet,
        status: 'CONFIRMED',
      }).lean();

      const desired = new Map<string, DesiredEntry>();

      for (const record of records) {
        let entry: DesiredEntry | null = null;

        if (record.type === 'PURCHASE' || record.type === 'UPGRADE') {
          if (!record.txHash) continue;
          const source: PointsSource =
            record.type === 'PURCHASE' ? 'MEMBERSHIP_PURCHASE' : 'MEMBERSHIP_UPGRADE';
          const usdValue = record.amount || 0;
          const amount = Math.round(usdValue * MULTIPLIERS[source]);
          if (amount <= 0) continue;
          const entryKey = membershipEntryKey(source, record.txHash);
          entry = {
            entryKey,
            source,
            amount,
            usdValue,
            txHash: record.txHash.toLowerCase(),
            timestamp: record.timestamp ? new Date(record.timestamp) : new Date(),
          };
        } else if (record.type === 'COMMISSION_EARNED') {
          if (!record.txHash) continue;
          const usdValue = (record.liquidAmount || 0) + (record.lockedAmount || 0);
          const amount = Math.round(usdValue * MULTIPLIERS.COMMISSION_EARNED);
          if (amount <= 0) continue;
          const level = record.level ?? 0;
          const entryKey = commissionEntryKey(record.txHash, level, record.token);
          entry = {
            entryKey,
            source: 'COMMISSION_EARNED',
            amount,
            usdValue,
            txHash: record.txHash.toLowerCase(),
            level,
            timestamp: record.timestamp ? new Date(record.timestamp) : new Date(),
          };
        }

        if (!entry) continue;
        // Last write wins for identical keys (should be identical amounts).
        desired.set(entry.entryKey, entry);
      }

      for (const entry of desired.values()) {
        try {
          await PointsLedger.updateOne(
            { walletAddress: normalizedWallet, entryKey: entry.entryKey },
            {
              $set: {
                amount: entry.amount,
                source: entry.source,
                usdValue: entry.usdValue,
                txHash: entry.txHash,
                level: entry.level,
                timestamp: entry.timestamp,
              },
              $setOnInsert: {
                walletAddress: normalizedWallet,
                entryKey: entry.entryKey,
              },
            },
            { upsert: true },
          );
        } catch (err: any) {
          if (isDuplicateKeyError(err)) {
            // Concurrent insert of the same logical row — safe to continue.
            continue;
          }
          throw err;
        }
      }

      // Drop orphan / legacy rows that are not part of the desired set.
      const keepKeys = [...desired.keys()];
      if (keepKeys.length > 0) {
        await PointsLedger.deleteMany({
          walletAddress: normalizedWallet,
          entryKey: { $nin: keepKeys },
        });
        // Also remove legacy rows that predate entryKey.
        await PointsLedger.deleteMany({
          walletAddress: normalizedWallet,
          entryKey: { $exists: false },
        });
      } else {
        await PointsLedger.deleteMany({ walletAddress: normalizedWallet });
      }

      const remaining = await PointsLedger.find({ walletAddress: normalizedWallet }).lean();
      const totalPoints = remaining.reduce((sum, row) => sum + (row.amount || 0), 0);

      await User.findOneAndUpdate(
        { walletAddress: normalizedWallet },
        { $set: { hntrPoints: totalPoints } },
        { upsert: false },
      );

      logger.info(`Recalculated HNTR points for ${normalizedWallet}: ${totalPoints}`);
      return totalPoints;
    });
  }

  /** Global gate so overlapping cron ticks cannot run two full reconciles at once. */
  private static reconcileAllInFlight: Promise<void> | null = null;

  /**
   * Recalculates points for every wallet. Intended for cron reconciliation.
   */
  static async recalculateAllPoints(): Promise<void> {
    if (this.reconcileAllInFlight) {
      logger.warn('Points reconciliation already in progress; skipping overlapping run');
      await this.reconcileAllInFlight;
      return;
    }

    this.reconcileAllInFlight = (async () => {
      const wallets = await User.distinct('walletAddress');
      logger.info(`Recalculating HNTR points for ${wallets.length} wallets`);

      for (const wallet of wallets) {
        try {
          await this.recalculatePoints(wallet);
        } catch (err: any) {
          logger.error(`Failed to recalculate points for ${wallet}: ${err.message}`);
        }
      }
    })();

    try {
      await this.reconcileAllInFlight;
    } finally {
      this.reconcileAllInFlight = null;
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
