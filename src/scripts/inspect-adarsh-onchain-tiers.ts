/**
 * Compare DB vs on-chain tiers for adarsh's tree.
 *   npx tsx src/scripts/inspect-adarsh-onchain-tiers.ts
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import User from '../models/User';
import { hntrContract } from '../services/contract.service';
import { TIER_VOLUMES, Tier } from '../constants';

const NAMES = ['adarsh', 'user1', 'user2', 'user3', 'user4', 'user5', 'user6', 'user7', 'user8'];
const TIERS = ['None', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];

async function main() {
  await connectDB();
  const users = await User.find({ username: { $in: NAMES } })
    .select('username tier walletAddress')
    .lean();

  const rows = [];
  for (const u of users) {
    let onChainTier: string | null = null;
    try {
      const r = await hntrContract.getUser(u.walletAddress);
      onChainTier = TIERS[Number(r[0])] ?? String(r[0]);
    } catch (e: any) {
      onChainTier = `err:${e.message}`;
    }
    const dbVol = TIER_VOLUMES[u.tier as Tier] || 0;
    const onChainVol =
      onChainTier && onChainTier in TIER_VOLUMES ? TIER_VOLUMES[onChainTier as Tier] : 0;
    rows.push({
      username: u.username,
      dbTier: u.tier,
      dbVol,
      onChainTier,
      onChainVol,
      mismatch: u.tier !== onChainTier,
    });
  }

  const byName = Object.fromEntries(rows.map((r) => [r.username, r]));
  const legNames = ['user1', 'user2', 'user3', 'user4', 'user8'];
  const chainTotal = legNames.reduce((s, n) => s + (byName[n]?.onChainVol || 0), 0);
  const dbTotal = legNames.reduce((s, n) => s + (byName[n]?.dbVol || 0), 0);

  console.log(
    JSON.stringify(
      {
        rows,
        user1Leg: {
          members: legNames.map((n) => byName[n]),
          dbTotal,
          onChainTotal: chainTotal,
          note: 'adarsh second competitive leg = user1 subtree including user1 personal volume',
        },
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
