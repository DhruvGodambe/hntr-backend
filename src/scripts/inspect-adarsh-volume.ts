/**
 * Inspect adarsh volume / legs.
 *   npx tsx src/scripts/inspect-adarsh-volume.ts
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import User from '../models/User';
import { TIER_VOLUMES, Tier } from '../constants';
import { NetworkService } from '../services/network.service';

function tierVol(tier: string): number {
  return TIER_VOLUMES[tier as Tier] || 0;
}

async function main() {
  await connectDB();

  const adarsh = await User.findOne({ username: 'adarsh' });
  if (!adarsh) {
    console.log('adarsh not found');
    process.exit(1);
  }

  const downlines = await User.find({ ancestors: 'adarsh' })
    .select('username tier rank sponsorUsername ancestors directDownline walletAddress teamVolume legVolumes')
    .lean();

  const directUsernames: string[] = adarsh.directDownline || [];
  const directs = await User.find({ username: { $in: directUsernames } })
    .select('username tier rank sponsorUsername directDownline teamVolume')
    .lean();

  const legs = [];
  for (const direct of directs) {
    const under = await User.find({ ancestors: direct.username }).select('username tier sponsorUsername').lean();
    let total = tierVol(direct.tier);
    const parts = [{ username: direct.username, tier: direct.tier, vol: tierVol(direct.tier), role: 'direct' }];
    for (const u of under) {
      const v = tierVol(u.tier);
      total += v;
      parts.push({ username: u.username, tier: u.tier, vol: v, role: 'descendant' });
    }
    legs.push({ leg: direct.username, total, parts });
  }

  // Also check anyone who has adarsh as sponsor but might be missing from directDownline
  const sponsored = await User.find({ sponsorUsername: 'adarsh' })
    .select('username tier sponsorUsername')
    .lean();

  console.log('=== BEFORE RECALC ===');
  console.log(
    JSON.stringify(
      {
        adarsh: {
          tier: adarsh.tier,
          rank: adarsh.rank,
          personalVol: tierVol(adarsh.tier),
          teamVolume: adarsh.teamVolume,
          directDownline: adarsh.directDownline,
          legVolumes: adarsh.legVolumes,
        },
        sponsoredByAdarsh: sponsored,
        directs,
        downlines: downlines.map((d) => ({
          username: d.username,
          tier: d.tier,
          sponsor: d.sponsorUsername,
          ancestors: d.ancestors,
          personalVol: tierVol(d.tier),
        })),
        manualLegCalc: legs,
        manualTeamTotal: legs.reduce((s, l) => s + l.total, 0),
        expectedIfMissing100: legs.reduce((s, l) => s + l.total, 0) + 100,
      },
      null,
      2,
    ),
  );

  console.log('\n=== RUNNING recalculateVolumes(adarsh) ===');
  const result = await NetworkService.recalculateVolumes('adarsh');
  const refreshed = await User.findOne({ username: 'adarsh' }).lean();
  console.log(
    JSON.stringify(
      {
        result,
        refreshed: {
          teamVolume: refreshed?.teamVolume,
          legVolumes: refreshed?.legVolumes,
          rank: refreshed?.rank,
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
