/**
 * Inspect who owns the company wallet + current admin row.
 *
 *   npx tsx src/scripts/inspect-admin-company-wallet.ts
 */
import mongoose from 'mongoose';
import { ethers } from 'ethers';
import { connectDB } from '../config/db';
import { ENV } from '../config/env';
import User from '../models/User';

async function main() {
  const companyWallet = new ethers.Wallet(ENV.COMPANY_WALLET_PRIVATE_KEY).address.toLowerCase();
  await connectDB();

  const admin = await User.findOne({ username: 'admin' }).lean();
  const byWallet = await User.findOne({ walletAddress: companyWallet }).lean();
  const byType = await User.find({ type: 'admin' }).lean();

  console.log(
    JSON.stringify(
      {
        companyWallet,
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
