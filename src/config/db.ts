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
    const collection = mongoose.connection.collection('transactions');
    const indexes = await collection.indexes();

    // The old single-field unique txHash index prevents multiple events from the same
    // transaction (e.g. MembershipPurchased + several CommissionEarned) from being stored.
    // Drop it so the new compound unique index can take over.
    const oldIndex = indexes.find((i) => i.name === 'txHash_1');
    if (oldIndex) {
      await collection.dropIndex('txHash_1');
      logger.info('Dropped old txHash_1 unique index from transactions collection');
    }
  } catch (err: any) {
    logger.warn(`Index migration warning: ${err.message}`);
  }
}
