/**
 * One-time data migration for the wallet naming/role restructure.
 *
 *   npx tsx src/scripts/migrate-wallet-rename.ts
 *
 * - Transaction.type  'COMPANY_WALLET_WITHDRAWN' -> 'UNCLAIMED_WITHDRAWN'
 * - DisbursementBatch.type 'ACHIEVEMENT'         -> 'RANK'
 *
 * Idempotent: re-running is a no-op once both collections are converted.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import Transaction from '../models/Transaction';
import DisbursementBatch from '../models/DisbursementBatch';

async function main() {
  await connectDB();

  const tx = await Transaction.updateMany(
    { type: 'COMPANY_WALLET_WITHDRAWN' },
    { $set: { type: 'UNCLAIMED_WITHDRAWN' } },
  );
  console.log(`Transaction: ${tx.modifiedCount} row(s) COMPANY_WALLET_WITHDRAWN -> UNCLAIMED_WITHDRAWN`);

  const batch = await DisbursementBatch.updateMany(
    { type: 'ACHIEVEMENT' },
    { $set: { type: 'RANK' } },
  );
  console.log(`DisbursementBatch: ${batch.modifiedCount} row(s) ACHIEVEMENT -> RANK`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
