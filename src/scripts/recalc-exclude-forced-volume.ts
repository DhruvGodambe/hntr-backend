/**
 * Recomputes every user's leg volumes / team volume / rank now that
 * forced memberships (admin tier overrides + gift-code/voucher redemptions,
 * both flagged `isForcedMembership`) no longer count toward team volume.
 *
 *   npx tsx src/scripts/recalc-exclude-forced-volume.ts          # dry run
 *   npx tsx src/scripts/recalc-exclude-forced-volume.ts --apply  # write changes
 *
 * Dry run recomputes teamVolume per user under the new rule (without saving)
 * and diffs it against the currently stored teamVolume, so you can see the
 * blast radius before writing to prod. --apply then calls the real
 * NetworkService.recalculateAllVolumes(), which also re-evaluates ranks,
 * clears/keeps forced-rank flags, and enqueues achievement bonuses exactly
 * as the live system would.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import User from '../models/User';
import { getTierVolumeUsd } from '../services/contract.service';
import { NetworkService } from '../services/network.service';

function qualifyingTierVolume(u: { tier: string; isForcedMembership?: boolean }): number {
  if (u.isForcedMembership) return 0;
  return getTierVolumeUsd(u.tier);
}

async function computeTeamVolume(username: string): Promise<number> {
  const user = await User.findOne({ username }).select('directDownline');
  if (!user) return 0;
  const directDownline = [...new Set(user.directDownline || [])].filter((d) => d && d !== username);

  let teamVolume = 0;
  for (const direct of directDownline) {
    const directUser = await User.findOne({ username: direct }).select('tier isForcedMembership');
    if (directUser) teamVolume += qualifyingTierVolume(directUser);

    const downlinesOfDirect = await User.find({ ancestors: direct }).select('tier isForcedMembership');
    for (const dl of downlinesOfDirect) teamVolume += qualifyingTierVolume(dl);
  }
  return teamVolume;
}

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDB();

  const forcedCount = await User.countDocuments({ isForcedMembership: true });
  console.log(`Users with a forced/gift-code membership: ${forcedCount}\n`);

  const usernames = await User.distinct('username');
  console.log(`Scanning ${usernames.length} users...\n`);

  let changed = 0;
  for (const username of usernames) {
    if (!username) continue;
    const user = await User.findOne({ username }).select('teamVolume rank');
    if (!user) continue;

    const newVolume = await computeTeamVolume(username);
    if (newVolume !== (user.teamVolume ?? 0)) {
      changed += 1;
      console.log(
        `${username}: teamVolume ${user.teamVolume ?? 0} -> ${newVolume} (rank currently ${user.rank})`,
      );
    }
  }

  console.log(`\n${changed} user(s) would have a different teamVolume under the new rule.`);

  if (apply) {
    console.log('\nApplying: recalculating leg volumes / team volume / rank for everyone...');
    const res = await NetworkService.recalculateAllVolumes();
    console.log(`Recalc done: updated=${res.updated} failed=${res.failed}`);
  } else {
    console.log('Dry run — re-run with --apply to write and recalc.');
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
