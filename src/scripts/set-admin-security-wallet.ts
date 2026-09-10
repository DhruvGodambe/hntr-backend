/**
 * Moves the security wallet address onto the admin user row (clears it from any
 * other user first). DB only — no private key, no on-chain tx.
 *
 *   npx tsx src/scripts/set-admin-security-wallet.ts [0x<address>]
 *
 * With no arg the address is read from the on-chain securityWallet().
 */
import mongoose from 'mongoose';
import { ethers } from 'ethers';
import { connectDB } from '../config/db';
import { hntrContract } from '../services/contract.service';
import User from '../models/User';

const ADMIN_USERNAME = 'admin';

async function main() {
  try {
    const argAddr = process.argv[2];
    const securityWalletAddr = (
      argAddr && ethers.isAddress(argAddr)
        ? argAddr
        : String(await hntrContract.securityWallet())
    ).toLowerCase();
    if (!ethers.isAddress(securityWalletAddr)) {
      throw new Error('Could not resolve the security wallet address (pass it as the first arg)');
    }
    await connectDB();

    const admin = await User.findOne({ username: ADMIN_USERNAME });
    if (!admin) {
      throw new Error(`User "${ADMIN_USERNAME}" not found`);
    }

    const previousOwner = await User.findOne({
      walletAddress: securityWalletAddr,
      username: { $ne: ADMIN_USERNAME },
    });

    if (previousOwner) {
      // Free the unique wallet index so admin can take the security address.
      previousOwner.walletAddress = undefined as any;
      previousOwner.set('walletAddress', undefined);
      await previousOwner.updateOne({ $unset: { walletAddress: 1 } });
      console.log(
        `Cleared security wallet from previous owner: username=${previousOwner.username} _id=${previousOwner._id}`,
      );
    }

    admin.walletAddress = securityWalletAddr;
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
          securityWalletAddr,
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
