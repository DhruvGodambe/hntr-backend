import cron from 'node-cron';
import mongoose from 'mongoose';
import { isPriorityLineReconcilerEnabled, reconcilePriorityLineDeposits } from '../services/priorityLineReconciler.service';
import { logger } from '../utils/logger';

export function initPriorityLineCron(tz: { timezone: string }) {
  if (!isPriorityLineReconcilerEnabled()) {
    logger.info('Priority Line deposit reconciler disabled (PRIORITY_LINE_RECONCILE=false)');
    return;
  }

  // Every minute: credit any deposit-wallet transfer whose browser confirm never arrived.
  cron.schedule(
    '* * * * *',
    async () => {
      if (mongoose.connection.readyState !== 1) return;
      try {
        await reconcilePriorityLineDeposits();
      } catch (err) {
        logger.error(`[CRON ERROR] priority line reconcile: ${(err as Error).message}`);
      }
    },
    tz,
  );
}
