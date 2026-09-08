import cron from 'node-cron';
import mongoose from 'mongoose';
import { RewardsService } from '../services/rewards.service';
import { PointsService } from '../services/points.service';
import { NetworkService } from '../services/network.service';
import AchievementBonus from '../models/AchievementBonus';
import Payout from '../models/Payout';
import User from '../models/User';
import { LEADERSHIP_ELIGIBLE_RANKS } from '../constants';
import { initVoucherCron } from './voucher-cron';

const CRON_TZ = { timezone: 'UTC' as const };

/**
 * Admin-triggered (or manual CLI) leadership payout entrypoint.
 * Uses two-hop dispersal: protocol wallet → burner → users.
 */
export async function runMonthlyLeadershipPayout(triggeredBy = 'system') {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Database not connected. Cannot run leadership payout.');
  }

  console.log('\n======================================================');
  console.log(`⏰ [LEADERSHIP PAYOUT] Starting (admin/manual two-hop)...`);
  console.log(`Date: ${new Date().toISOString()} triggeredBy=${triggeredBy}`);
  console.log('======================================================');

  const payouts = await RewardsService.calculateMonthlyLeadershipPool(triggeredBy);
  const paid = payouts.filter((p) => p.status === 'PAID');
  const failed = payouts.filter((p) => p.status === 'FAILED');

  console.log(
    `✅ [LEADERSHIP PAYOUT COMPLETE] created ${payouts.length} ` +
      `(${paid.length} paid, ${failed.length} failed).`,
  );
  for (const p of paid) {
    console.log(`   • ${p.username}: $${p.amountUSDC.toFixed(2)} (${p.shares} shares, ${p.rank})`);
  }

  return {
    payouts,
    paid: paid.length,
    failed: failed.length,
    month: new Date().toISOString().slice(0, 7),
  };
}

/**
 * Admin-triggered (or manual CLI) achievement payout entrypoint.
 * Uses two-hop dispersal: protocol wallet → burner → users.
 */
export async function runAchievementBonusDisbursement(triggeredBy = 'system') {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Database not connected. Cannot run achievement disbursement.');
  }

  console.log('\n======================================================');
  console.log(`⏰ [ACHIEVEMENT PAYOUT] Starting (admin/manual two-hop)...`);
  console.log(`Date: ${new Date().toISOString()} triggeredBy=${triggeredBy}`);
  console.log('======================================================');

  const paid = await RewardsService.disbursePendingAchievementBonuses(triggeredBy);
  console.log(
    `✅ [ACHIEVEMENT PAYOUT COMPLETE] paid ${paid.length} pending payout(s).`,
  );
  for (const p of paid) {
    console.log(`   • ${p.username}: $${p.amountUSD.toFixed(2)} (${p.rank})`);
  }

  return { payouts: paid, paid: paid.length };
}

/**
 * Backfill entrypoint: only runs achievement disbursement when PENDING rows exist,
 * so the frequent poll stays quiet when there's nothing to do.
 */
async function backfillAchievementBonusesIfNeeded() {
  if (mongoose.connection.readyState !== 1) return;

  const pendingCount = await AchievementBonus.countDocuments({ status: 'PENDING' });
  if (pendingCount === 0) return;

  console.log(
    `⏰ [ACHIEVEMENT BACKFILL] ${pendingCount} PENDING bonus(es) found — disbursing...`,
  );
  await runAchievementBonusDisbursement();
}

/**
 * Backfill entrypoint: if this UTC month still has eligible leaders with no Payout
 * row yet, run the monthly distribution. Safe to call daily — already-paid users
 * are skipped inside calculateMonthlyLeadershipPool.
 */
async function backfillLeadershipPayoutIfNeeded() {
  if (mongoose.connection.readyState !== 1) return;

  const month = new Date().toISOString().slice(0, 7);
  const eligibleCount = await User.countDocuments({
    rank: { $in: [...LEADERSHIP_ELIGIBLE_RANKS] },
  });
  if (eligibleCount === 0) return;

  const paidThisMonth = await Payout.countDocuments({
    month,
    status: 'PAID',
  });
  if (paidThisMonth >= eligibleCount) return;

  console.log(
    `⏰ [LEADERSHIP BACKFILL] month=${month} eligible=${eligibleCount} paid=${paidThisMonth} — running distribution...`,
  );
  await runMonthlyLeadershipPayout();
}

/**
 * Initializes all background cron jobs for the HNTR backend.
 * All schedules use UTC explicitly (node-cron otherwise uses the host local timezone).
 */
export function initCronJobs() {
  console.log('🕒 Initializing Background Cron Jobs (timezone=UTC)...');

  // Voucher expiry + refund, stale-lock sweep, burner gas alert (every 15 min).
  initVoucherCron(CRON_TZ);

  // DISABLED: admin-triggered two-hop dispersal replaces auto-pay
  // Primary monthly leadership pool: 1st of every month at 00:00 UTC.
  // cron.schedule(
  //   '0 0 1 * *',
  //   async () => {
  //     try {
  //       await runMonthlyLeadershipPayout();
  //     } catch (error) {
  //       console.error(`❌ [CRON ERROR] Failed to generate leadership payouts:`, error);
  //     }
  //   },
  //   CRON_TZ,
  // );

  // DISABLED: admin-triggered two-hop dispersal replaces auto-pay
  // Leadership backfill: every day at 01:00 UTC. Catches a missed 1st-of-month tick
  // while the process was briefly down / restarted. Already-paid users are skipped.
  // cron.schedule(
  //   '0 1 * * *',
  //   async () => {
  //     try {
  //       await backfillLeadershipPayoutIfNeeded();
  //     } catch (error) {
  //       console.error(`❌ [CRON ERROR] Failed leadership backfill:`, error);
  //     }
  //   },
  //   CRON_TZ,
  // );

  // DISABLED: admin-triggered two-hop dispersal replaces auto-pay
  // Primary daily rank achievement bonuses: 00:30 UTC.
  // cron.schedule(
  //   '30 0 * * *',
  //   async () => {
  //     try {
  //       await runAchievementBonusDisbursement();
  //     } catch (error) {
  //       console.error(`❌ [CRON ERROR] Failed to disburse achievement bonuses:`, error);
  //     }
  //   },
  //   CRON_TZ,
  // );

  // Points + leg-volume reconcile every 10 minutes.
  // Volume backfill corrects stale legVolumes when the blockchain listener misses
  // an upline recalculation after purchase/upgrade.
  // Achievement auto-backfill is DISABLED (admin Distribute Rank Bonuses instead).
  cron.schedule(
    '*/10 * * * *',
    async () => {
      console.log(`⏰ [CRON START] Reconciling HNTR points + leg volumes...`);

      try {
        if (mongoose.connection.readyState !== 1) {
          console.log('⚠️ Database not connected. Skipping reconciliation.');
          return;
        }

        await PointsService.recalculateAllPoints();
        console.log(`✅ [CRON COMPLETE] HNTR points reconciled.`);
      } catch (error) {
        console.error(`❌ [CRON ERROR] Failed to reconcile HNTR points:`, error);
      }

      try {
        const volumeResult = await NetworkService.recalculateAllVolumes();
        console.log(
          `✅ [CRON COMPLETE] Leg volumes reconciled (updated=${volumeResult.updated}, failed=${volumeResult.failed}).`,
        );
      } catch (error) {
        console.error(`❌ [CRON ERROR] Failed to reconcile leg volumes:`, error);
      }

      // DISABLED: admin-triggered two-hop dispersal replaces auto-pay
      // try {
      //   await backfillAchievementBonusesIfNeeded();
      // } catch (error) {
      //   console.error(`❌ [CRON ERROR] Failed achievement backfill:`, error);
      // }
    },
    CRON_TZ,
  );

  // Immediate catch-up on boot (volume only — payout catch-up disabled).
  setImmediate(async () => {
    // DISABLED: admin-triggered two-hop dispersal replaces auto-pay
    // try {
    //   await backfillAchievementBonusesIfNeeded();
    // } catch (error) {
    //   console.error(`❌ [STARTUP] Failed achievement catch-up:`, error);
    // }

    // DISABLED: admin-triggered two-hop dispersal replaces auto-pay
    // try {
    //   await backfillLeadershipPayoutIfNeeded();
    // } catch (error) {
    //   console.error(`❌ [STARTUP] Failed leadership catch-up:`, error);
    // }

    try {
      if (mongoose.connection.readyState === 1) {
        const volumeResult = await NetworkService.recalculateAllVolumes();
        console.log(
          `✅ [STARTUP] Leg volumes reconciled (updated=${volumeResult.updated}, failed=${volumeResult.failed}).`,
        );
      }
    } catch (error) {
      console.error(`❌ [STARTUP] Failed volume catch-up:`, error);
    }
  });

  // Silence unused-fn warnings while auto-pay schedules stay commented for restore.
  void backfillAchievementBonusesIfNeeded;
  void backfillLeadershipPayoutIfNeeded;

  console.log(
    '🕒 Cron jobs scheduled (UTC): points+volumes */10 * * * *, startup volume catch-up. ' +
      'Leadership/achievement auto-pay DISABLED (admin two-hop distribute only).',
  );
}
