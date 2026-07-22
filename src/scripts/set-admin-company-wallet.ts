/**
 * Moves company wallet onto admin (clears it from any other user first).
 *
 *   npx tsx src/scripts/set-admin-company-wallet.ts
 */
import mongoose from 'mongoose';
import { ethers } from 'ethers';
import { connectDB } from '../config/db';
import { ENV } from '../config/env';
import User from '../models/User';

const ADMIN_USERNAME = 'admin';

async function main() {
  try {
    if (!ENV.COMPANY_WALLET_PRIVATE_KEY) {
      throw new Error('COMPANY_WALLET_PRIVATE_KEY is not set');
    }

    const companyWallet = new ethers.Wallet(ENV.COMPANY_WALLET_PRIVATE_KEY).address.toLowerCase();
    await connectDB();

    const admin = await User.findOne({ username: ADMIN_USERNAME });
    if (!admin) {
      throw new Error(`User "${ADMIN_USERNAME}" not found`);
    }

    const previousOwner = await User.findOne({
      walletAddress: companyWallet,
      username: { $ne: ADMIN_USERNAME },
    });

    if (previousOwner) {
      // Free the unique wallet index so admin can take the company address.
      previousOwner.walletAddress = undefined as any;
      previousOwner.set('walletAddress', undefined);
      await previousOwner.updateOne({ $unset: { walletAddress: 1 } });
      console.log(
        `Cleared company wallet from previous owner: username=${previousOwner.username} _id=${previousOwner._id}`,
      );
    }

    admin.walletAddress = companyWallet;
    await admin.save();

    const refreshed = await User.findOne({ username: ADMIN_USERNAME }).lean();
    console.log('ADMIN_UPDATED');
    console.log(
      JSON.stringify(
        {
          username: refreshed?.username,
          type: (refreshed as any)?.type,
          walletAddress: refreshed?.walletAddress,
          sponsorUsername: refreshed?.sponsorUsername,
          ancestors: refreshed?.ancestors,
          directDownline: refreshed?.directDownline,
          tier: refreshed?.tier,
          rank: refreshed?.rank,
          teamVolume: refreshed?.teamVolume,
          hntrPoints: refreshed?.hntrPoints,
          joinedAt: refreshed?.joinedAt,
          _id: refreshed?._id,
          previousWalletOwner: previousOwner
            ? { username: previousOwner.username, _id: previousOwner._id }
            : null,
          companyWallet,
        },
        null,
        2,
      ),
    );

    await mongoose.connection.close();
    process.exit(0);
  } catch (error: any) {
    console.error(error.message || error);
    try {
      await mongoose.connection.close();
    } catch {
      // ignore
    }
    process.exit(1);
  }
}

main();
