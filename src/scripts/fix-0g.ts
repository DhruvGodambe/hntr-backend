import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import User from '../models/User';
import { NetworkService } from '../services/network.service';
import { logger } from '../utils/logger';

/**
 * One-off repair script for the 0G account.
 *
 * Recalculates 0G's leg volumes, team volume, and rank by walking the entire
 * upline chain. Run with:
 *
 *   npx tsx src/scripts/fix-0g.ts
 *
 * The script exits with code 0 on success and 1 on failure.
 */
async function fix0G() {
  try {
    await connectDB();

    const username = process.argv[2] || '0G';
    logger.info(`Starting volume repair for ${username}...`);

    const user = await User.findOne({ username });
    if (!user) {
      logger.error(`User "${username}" not found in database.`);
      await mongoose.disconnect();
      process.exit(1);
    }

    logger.info(`Found ${username}: directDownline=[${user.directDownline.join(', ')}], currentTeamVolume=${user.teamVolume}`);

    const results = await NetworkService.recalculateUplineVolumes(username);

    logger.info(`${username} repair complete. Updated chain:`);
    for (const result of results) {
      logger.info(`  ${result.username}: teamVolume=${result.teamVolume}, rank=${result.rank}`);
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (error: any) {
    logger.error('0G repair failed:', error.message);
    try {
      await mongoose.disconnect();
    } catch {
      // ignore disconnect errors
    }
    process.exit(1);
  }
}

fix0G();
