import cron from 'node-cron';
import { RewardsService } from '../services/rewards.service';
import mongoose from 'mongoose';

/**
 * Initializes all background cron jobs for the HNTR backend.
 */
export function initCronJobs() {
  console.log('🕒 Initializing Background Cron Jobs...');

  // Schedule the Leadership Pool Distribution to run on the 1st of every month at 00:00.
  // cron syntax: '0 0 1 * *' (minute, hour, day of month, month, day of week)
  cron.schedule('0 0 1 * *', async () => {
    console.log('\n======================================================');
    console.log(`⏰ [CRON START] Executing Monthly Leadership Payout Generation...`);
    console.log(`Date: ${new Date().toISOString()}`);
    console.log('======================================================');

    try {
      // Ensure database connection is active before running
      if (mongoose.connection.readyState !== 1) {
          console.log('⚠️ Database not connected. Skipping cron job.');
          return;
      }
      
      const payouts = await RewardsService.calculateMonthlyLeadershipPool();
      
      console.log(`✅ [CRON COMPLETE] Generated ${payouts.length} new payouts.`);
    } catch (error) {
      console.error(`❌ [CRON ERROR] Failed to generate leadership payouts:`, error);
    }
  });

  console.log('🕒 Cron jobs successfully scheduled.');
}
