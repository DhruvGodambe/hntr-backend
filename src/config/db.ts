import mongoose from 'mongoose';
import { ENV } from './env';
import { logger } from '../utils/logger';

export const connectDB = async () => {
  try {
    const conn = await mongoose.connect(ENV.MONGO_URI);
    logger.info(`MongoDB Connected: ${conn.connection.host}`);
    await ensureTransactionIndexes();
  } catch (error: any) {
    logger.error(`Error connecting to MongoDB: ${error.message}`);
    process.exit(1);
  }
};

async function ensureTransactionIndexes() {
  try {
    const txCollection = mongoose.connection.collection('transactions');
    const txIndexes = await txCollection.indexes();

    // The old single-field unique txHash index prevents multiple events from the same
    // transaction (e.g. MembershipPurchased + several CommissionEarned) from being stored.
    // Drop it so the new compound unique index can take over.
    const oldTxHashIndex = txIndexes.find((i) => i.name === 'txHash_1');
    if (oldTxHashIndex) {
      await txCollection.dropIndex('txHash_1');
      logger.info('Dropped old txHash_1 unique index from transactions collection');
    }

    // Legacy pending lock was per wallet+type only, which blocked USDC claims while a
    // USDT COMMISSION_CLAIM was still PENDING. Replace with wallet+type+token.
    const legacyPendingLock = txIndexes.find((i) => i.name === 'walletAddress_1_type_1');
    if (legacyPendingLock) {
      await txCollection.dropIndex('walletAddress_1_type_1');
      logger.info('Dropped legacy walletAddress_1_type_1 pending unique index');
    }

    const pendingLockName = 'walletAddress_1_type_1_token_1';
    const pendingLock = txIndexes.find((i) => i.name === pendingLockName);
    if (!pendingLock) {
      await txCollection.createIndex(
        { walletAddress: 1, type: 1, token: 1 },
        {
          unique: true,
          name: pendingLockName,
          partialFilterExpression: { status: 'PENDING' },
        },
      );
      logger.info(`Created ${pendingLockName} partial unique pending-relay index`);
    }

    // Replace compound sparse unique with a partial unique on real txHash strings.
    // Sparse compound indexes still indexed PENDING/FAILED stubs (walletAddress/type/token
    // present, txHash null), so a second claim for the same wallet+token hit E11000.
    const compoundName = 'txHash_1_walletAddress_1_type_1_token_1_level_1';
    const compoundIndex = txIndexes.find((i) => i.name === compoundName);
    const needsCompoundRebuild =
      !!compoundIndex &&
      (!(compoundIndex as { partialFilterExpression?: unknown }).partialFilterExpression ||
        (compoundIndex as { sparse?: boolean }).sparse === true);

    if (needsCompoundRebuild) {
      await txCollection.dropIndex(compoundName);
      logger.info(`Dropped legacy ${compoundName} sparse unique index from transactions`);
      await txCollection.createIndex(
        { txHash: 1, walletAddress: 1, type: 1, token: 1, level: 1 },
        {
          unique: true,
          name: compoundName,
          partialFilterExpression: { txHash: { $type: 'string' } },
        },
      );
      logger.info(`Recreated ${compoundName} as partial unique (txHash string only)`);
    }
  } catch (err: any) {
    logger.warn(`Transaction index migration warning: ${err.message}`);
  }

  try {
    const pointsCollection = mongoose.connection.collection('pointsledgers');
    const pointsIndexes = await pointsCollection.indexes();

    // Replace the old sparse unique (txHash, walletAddress, source) which raced with
    // delete+recreate reconciliation and could not distinguish multi-level commissions.
    const legacyPointsIndex = pointsIndexes.find(
      (i) => i.name === 'txHash_1_walletAddress_1_source_1',
    );
    if (legacyPointsIndex) {
      await pointsCollection.dropIndex('txHash_1_walletAddress_1_source_1');
      logger.info('Dropped legacy pointsledgers txHash_1_walletAddress_1_source_1 index');
    }

    // Legacy rows without entryKey break the new unique index (multiple nulls).
    // Drop them — the next points cron rebuilds from CONFIRMED transactions.
    const legacyDelete = await pointsCollection.deleteMany({
      $or: [{ entryKey: { $exists: false } }, { entryKey: null }],
    });
    if (legacyDelete.deletedCount > 0) {
      logger.info(
        `Removed ${legacyDelete.deletedCount} legacy pointsledger row(s) missing entryKey (will rebuild on cron)`,
      );
    }
  } catch (err: any) {
    logger.warn(`Points ledger index migration warning: ${err.message}`);
  }
}
