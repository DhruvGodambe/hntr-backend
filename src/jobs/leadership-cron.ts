import cron from 'node-cron';
import { RewardsService } from '../services/rewards.service';
import { PointsService } from '../services/points.service';
import mongoose from 'mongoose';

/**
 * Initializes all background cron jobs for the HNTR backend.
 */
export function initCronJobs() {
  console.log('🕒 Initializing Background Cron Jobs...');

  // Monthly leadership pool: 1st of every month at 00:00 UTC.
  // Distributes the on-chain leadershipWallet balance pro-rata by LEADERSHIP_SHARES
  // (Hunter=1, Elite Hunter=3, Master Hunter=7, Legend Hunter=15). Users below Hunter
  // have 0 shares and are skipped.
  cron.schedule('0 0 1 * *', async () => {
    console.log('\n======================================================');
    console.log(`⏰ [CRON START] Executing Monthly Leadership Payout Generation...`);
    console.log(`Date: ${new Date().toISOString()}`);
    console.log('======================================================');

    try {
      if (mongoose.connection.readyState !== 1) {
        console.log('⚠️ Database not connected. Skipping leadership cron job.');
        return;
      }

      const payouts = await RewardsService.calculateMonthlyLeadershipPool();
      const paid = payouts.filter((p) => p.status === 'PAID');
      const failed = payouts.filter((p) => p.status === 'FAILED');

      console.log(
        `✅ [CRON COMPLETE] Leadership payouts — created ${payouts.length} ` +
          `(${paid.length} paid, ${failed.length} failed).`,
      );
      for (const p of paid) {
        console.log(`   • ${p.username}: $${p.amountUSDC.toFixed(2)} (${p.shares} shares, ${p.rank})`);
      }
    } catch (error) {
      console.error(`❌ [CRON ERROR] Failed to generate leadership payouts:`, error);
    }
  });

  // Daily rank achievement bonuses: 00:30 UTC.
  // Pays PENDING one-time PDF bonuses from achievementWallet when it holds enough
  // USDT/USDC for each bonus (oldest first). Underfunded rows stay PENDING.
  cron.schedule('30 0 * * *', async () => {
    console.log('\n======================================================');
    console.log(`⏰ [CRON START] Executing Daily Rank Achievement Disbursement...`);
    console.log(`Date: ${new Date().toISOString()}`);
    console.log('======================================================');

    try {
      if (mongoose.connection.readyState !== 1) {
        console.log('⚠️ Database not connected. Skipping achievement cron job.');
        return;
      }

      const paid = await RewardsService.disbursePendingAchievementBonuses();
      console.log(
        `✅ [CRON COMPLETE] Achievement bonuses — paid ${paid.length} pending payout(s).`,
      );
      for (const p of paid) {
        console.log(`   • ${p.username}: $${p.amountUSD.toFixed(2)} (${p.rank})`);
      }
    } catch (error) {
      console.error(`❌ [CRON ERROR] Failed to disburse achievement bonuses:`, error);
    }
  });

  // Reconcile HNTR points every 10 minutes. The blockchain listener awards points in
  // real-time; this cron catches any missed events and fixes drift after restarts.
  cron.schedule('*/10 * * * *', async () => {
    console.log(`⏰ [CRON START] Reconciling HNTR points...`);

    try {
      if (mongoose.connection.readyState !== 1) {
        console.log('⚠️ Database not connected. Skipping points reconciliation.');
        return;
      }

      await PointsService.recalculateAllPoints();
      console.log(`✅ [CRON COMPLETE] HNTR points reconciled.`);
    } catch (error) {
      console.error(`❌ [CRON ERROR] Failed to reconcile HNTR points:`, error);
    }
  });

  console.log(
    '🕒 Cron jobs successfully scheduled (leadership: 0 0 1 * *, achievement: 30 0 * * *, points: */10 * * * *).',
  );
}
