/**
 * Repairs corrupt `directDownline` arrays across all users, then recomputes every
 * user's leg volumes / team volume / rank.
 *
 *   npx tsx src/scripts/repair-network-downlines.ts          # dry run
 *   npx tsx src/scripts/repair-network-downlines.ts --apply  # write changes
 *
 * `sponsorUsername` is the source of truth: a user's directDownline is exactly the
 * set of users who name them as sponsor. This fixes self-references (a name listed
 * in its own directDownline), duplicates, and stale/missing entries — all of which
 * inflate teamVolume and make getNetworkTree render the same users at every level.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import User from '../models/User';
import { NetworkService } from '../services/network.service';

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDB();

  const users = await User.find({}).select('username directDownline sponsorUsername');
  const bySponsor = new Map<string, string[]>();
  for (const u of users) {
    if (u.sponsorUsername && u.sponsorUsername !== u.username) {
      const arr = bySponsor.get(u.sponsorUsername) ?? [];
      arr.push(u.username);
      bySponsor.set(u.sponsorUsername, arr);
    }
  }

  let changed = 0;
  for (const u of users) {
    const correct = [...new Set(bySponsor.get(u.username) ?? [])].sort();
    const current = [...(u.directDownline ?? [])].sort();
    const same =
      correct.length === current.length && correct.every((v, i) => v === current[i]);
    if (same) continue;

    changed += 1;
    console.log(
      `${u.username}: directDownline [${(u.directDownline ?? []).join(', ')}] -> [${correct.join(', ')}]`,
    );
    if (apply) {
      u.directDownline = correct;
      await u.save();
    }
  }

  console.log(`\n${changed} user(s) ${apply ? 'repaired' : 'would change'}.`);

  if (apply && changed > 0) {
    console.log('Recomputing leg volumes / team volume / rank for everyone…');
    const res = await NetworkService.recalculateAllVolumes();
    console.log(`Recalc done: updated=${res.updated} failed=${res.failed}`);
  } else if (!apply) {
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
