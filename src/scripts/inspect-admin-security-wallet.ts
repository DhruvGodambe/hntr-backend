/**
 * Inspect who owns the security wallet + current admin row.
 *
 *   npx tsx src/scripts/inspect-admin-security-wallet.ts
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { hntrContract } from '../services/contract.service';
import User from '../models/User';

async function main() {
  const securityWalletAddr = String(await hntrContract.securityWallet()).toLowerCase();
  await connectDB();

  const admin = await User.findOne({ username: 'admin' }).lean();
  const byWallet = await User.findOne({ walletAddress: securityWalletAddr }).lean();
  const byType = await User.find({ type: 'admin' }).lean();

  console.log(
    JSON.stringify(
      {
        securityWalletAddr,
        admin,
        userWithCompanyWallet: byWallet,
        allAdmins: byType,
      },
      null,
      2,
    ),
  );

  await mongoose.connection.close();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.connection.close();
  } catch {
    // ignore
  }
  process.exit(1);
});
