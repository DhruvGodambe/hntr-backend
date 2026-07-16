import mongoose from 'mongoose';
import { connectDB } from '../config/db';
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

    logger.info('Starting 0G volume repair...');
    const results = await NetworkService.recalculateUplineVolumes('OG');

    logger.info('0G repair complete. Updated chain:');
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
