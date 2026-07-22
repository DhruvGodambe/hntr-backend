/**
 * Sets debayudh8 (or debayudh08) to Hunter so they get leadership pool shares.
 *
 *   npx tsx src/scripts/set-debayudh8-hunter.ts
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import User from '../models/User';
import AdminUserOverride from '../models/AdminUserOverride';
import { Rank } from '../constants';

const CANDIDATES = ['debayudh8', 'debayudh08'];

async function main() {
  await connectDB();

  let user = null as Awaited<ReturnType<typeof User.findOne>> | null;
  for (const username of CANDIDATES) {
    user = await User.findOne({ username });
    if (user) break;
  }

  if (!user) {
    throw new Error(`User not found. Tried: ${CANDIDATES.join(', ')}`);
  }

  const previousRank = user.rank;
  user.rank = Rank.HUNTER;
  // Hunter requires a qualifying tier in real flow; Diamond keeps gates open for testing.
  if (!user.tier || user.tier === 'None') {
    user.tier = 'Diamond';
  }
  await user.save();

  await AdminUserOverride.findOneAndUpdate(
    { username: user.username.toLowerCase() },
    {
      $set: {
        rankOverride: Rank.HUNTER,
        tierOverride: user.tier,
      },
    },
    { upsert: true },
  );

  console.log(
    JSON.stringify(
      {
        username: user.username,
        previousRank,
        rank: user.rank,
        tier: user.tier,
        walletAddress: user.walletAddress,
        leadershipShares: 1,
        note: 'Hunter is the minimum rank with leadership shares (1 share)',
      },
      null,
      2,
    ),
  );

  await mongoose.connection.close();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e.message || e);
  try {
    await mongoose.connection.close();
  } catch {
    // ignore
  }
  process.exit(1);
});
