/**
 * Creates the system root admin user (no wallet, no sponsor, type=admin).
 *
 *   npx tsx src/scripts/seed-admin-root.ts
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import User from '../models/User';
import { Tier, Rank } from '../constants';

const ADMIN_USERNAME = 'admin';

async function seedAdminRoot() {
  try {
    await connectDB();

    const existing = await User.findOne({
      $or: [{ username: ADMIN_USERNAME }, { type: 'admin' }],
    });

    if (existing) {
      console.log(
        `Admin root already exists: username=${existing.username} type=${(existing as any).type} wallet=${JSON.stringify(existing.walletAddress)}`,
      );
      await mongoose.disconnect();
      process.exit(0);
    }

    const admin = await User.create({
      username: ADMIN_USERNAME,
      walletAddress: '',
      type: 'admin',
      email: undefined,
      phone: undefined,
      sponsorUsername: null,
      ancestors: [],
      directDownline: [],
      tier: Tier.NONE,
      rank: Rank.NONE,
      teamVolume: 0,
      legVolumes: {},
      hntrPoints: 0,
    });

    console.log(
      `Created admin root: username=${admin.username} type=${(admin as any).type} wallet=${JSON.stringify(admin.walletAddress)} sponsor=${admin.sponsorUsername}`,
    );

    await mongoose.disconnect();
    process.exit(0);
  } catch (error: any) {
    console.error('Failed to seed admin root:', error.message);
    try {
      await mongoose.disconnect();
    } catch {
      // ignore
    }
    process.exit(1);
  }
}

seedAdminRoot();
