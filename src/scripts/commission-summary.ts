/**
 * Read-only summary of commission activity across the system:
 *   - referral commissions earned vs withdrawn vs unclaimed-swept (Transaction)
 *   - leadership / rank / achievement pool payouts (DisbursementBatch)
 *
 *   npx tsx src/scripts/commission-summary.ts
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import Transaction from '../models/Transaction';
import DisbursementBatch from '../models/DisbursementBatch';

async function main() {
  await connectDB();

  console.log('=== Referral commissions (Transaction) ===\n');
  const agg: { _id: { type: string; token: string }; total: number; count: number }[] =
    await Transaction.aggregate([
      {
        $match: {
          type: {
            $in: [
              'COMMISSION_EARNED',
              'COMMISSION_WITHDRAWN',
              'UNCLAIMED_WITHDRAWN',
              'COMPANY_WALLET_WITHDRAWN',
            ],
          },
          status: 'CONFIRMED',
        },
      },
      {
        $group: {
          _id: { type: '$type', token: '$token' },
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.type': 1, '_id.token': 1 } },
    ]);

  for (const row of agg) {
    console.log(
      `${row._id.type} (${row._id.token ?? 'n/a'}): $${row.total.toFixed(2)} across ${row.count} row(s)`,
    );
  }

  const byToken = new Map<string, { earned: number; withdrawn: number; swept: number }>();
  for (const row of agg) {
    const token = row._id.token ?? 'UNKNOWN';
    const entry = byToken.get(token) ?? { earned: 0, withdrawn: 0, swept: 0 };
    if (row._id.type === 'COMMISSION_EARNED') entry.earned += row.total;
    if (row._id.type === 'COMMISSION_WITHDRAWN') entry.withdrawn += row.total;
    if (row._id.type === 'UNCLAIMED_WITHDRAWN' || row._id.type === 'COMPANY_WALLET_WITHDRAWN')
      entry.swept += row.total;
    byToken.set(token, entry);
  }

  console.log('\n--- Earned vs disbursed (withdrawn + swept), by token ---');
  for (const [token, e] of byToken) {
    const disbursed = e.withdrawn + e.swept;
    console.log(
      `${token}: earned=$${e.earned.toFixed(2)} disbursed=$${disbursed.toFixed(2)} ` +
        `(withdrawn=$${e.withdrawn.toFixed(2)}, swept-unclaimed=$${e.swept.toFixed(2)}) ` +
        `outstanding(on-chain, not yet claimed)=$${(e.earned - disbursed).toFixed(2)}`,
    );
  }

  console.log('\n=== Pool disbursements (DisbursementBatch, PAID entries) ===\n');
  const batches = await DisbursementBatch.find({}).select('type month status dispersals');
  const poolByTypeToken = new Map<string, { total: number; count: number }>();
  for (const b of batches) {
    for (const d of b.dispersals) {
      if (d.status !== 'PAID') continue;
      const key = `${b.type}:${d.token}`;
      const entry = poolByTypeToken.get(key) ?? { total: 0, count: 0 };
      entry.total += d.amount;
      entry.count += 1;
      poolByTypeToken.set(key, entry);
    }
  }
  for (const [key, e] of poolByTypeToken) {
    console.log(`${key}: $${e.total.toFixed(2)} across ${e.count} payout(s)`);
  }

  const batchStatusCounts = await DisbursementBatch.aggregate([
    { $group: { _id: { type: '$type', status: '$status' }, count: { $sum: 1 } } },
  ]);
  console.log('\n--- Batch status counts ---');
  for (const row of batchStatusCounts) {
    console.log(`${row._id.type} / ${row._id.status}: ${row.count}`);
  }

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
