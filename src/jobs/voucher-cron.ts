import cron from 'node-cron';
import mongoose from 'mongoose';
import Voucher from '../models/Voucher';
import { applyBalanceDelta } from '../services/voucherBalance';
import { getBurnerHealth } from '../services/contract.service';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Expire ACTIVE vouchers past their 7-day window and refund the issuer's balance.
 * The status flip is atomic so exactly one worker processes each voucher, and the
 * refund carries a unique ledger entryKey so a crash mid-refund self-heals.
 */
export async function expireAndRefundVouchers(): Promise<{ expired: number; refunded: number }> {
  const now = new Date();
  const due = await Voucher.find({ status: 'ACTIVE', expiresAt: { $lte: now } }).select('_id voucherId');

  let expired = 0;
  let refunded = 0;
  for (const stub of due) {
    const claimed = await Voucher.findOneAndUpdate(
      { _id: stub._id, status: 'ACTIVE', expiresAt: { $lte: now } },
      { $set: { status: 'EXPIRED', expiredAt: now } },
      { new: true },
    );
    if (!claimed) continue; // someone else took it (redeem or revoke)
    expired += 1;

    try {
      await applyBalanceDelta({
        walletAddress: claimed.issuerWallet,
        token: claimed.token,
        delta: claimed.amountUsd,
        reason: 'VOUCHER_EXPIRY_REFUND',
        entryKey: `VOUCHER_EXPIRY_REFUND:${claimed.voucherId}`,
        voucherId: claimed.voucherId,
        note: 'auto-refund on expiry',
      });
      refunded += 1;
    } catch (err: any) {
      logger.error(`Voucher expiry refund failed for ${claimed.voucherId}: ${err.message}`);
    }
  }

  if (expired) logger.info(`Voucher cron: expired ${expired}, refunded ${refunded}.`);
  return { expired, refunded };
}

/** Return REDEEMING vouchers that have been stuck longer than the lock TTL to ACTIVE. */
export async function sweepStaleRedeeming(): Promise<number> {
  const cutoff = new Date(Date.now() - ENV.VOUCHER_REDEEM_LOCK_TTL_MS);
  const res = await Voucher.updateMany(
    {
      status: 'REDEEMING',
      redeemLockedAt: { $lte: cutoff },
      txHash: { $exists: false },
    } as Record<string, unknown>,
    { $set: { status: 'ACTIVE' }, $unset: { redeemLockedAt: 1 } },
  );
  const n = res.modifiedCount ?? 0;
  if (n) logger.warn(`Voucher cron: swept ${n} stale REDEEMING voucher(s) back to ACTIVE.`);
  return n;
}

let lastBurnerAlertAt = 0;

export async function checkBurnerGas(): Promise<void> {
  const health = await getBurnerHealth();
  if (!health.configuredAddress) return;
  if (health.healthy) return;

  // Throttle the alert to once per 6h so it isn't noisy.
  if (Date.now() - lastBurnerAlertAt < 6 * 60 * 60 * 1000) return;
  lastBurnerAlertAt = Date.now();

  const msg = !health.matches
    ? `Burner wallet mismatch: configured ${health.configuredAddress} vs on-chain ${health.onChainAddress}.`
    : `Burner wallet low on gas: ${health.balanceEth} ETH (min ${health.minEth}). Voucher redemptions will fail when it runs dry.`;
  logger.error(`[VOUCHER BURNER ALERT] ${msg}`);
}

export function initVoucherCron(tz: { timezone: string }) {
  // Every 15 minutes: expire + refund, sweep stale locks, check burner gas.
  cron.schedule(
    '*/15 * * * *',
    async () => {
      if (mongoose.connection.readyState !== 1) return;
      try {
        await expireAndRefundVouchers();
      } catch (err) {
        logger.error(`[CRON ERROR] voucher expiry: ${(err as Error).message}`);
      }
      try {
        await sweepStaleRedeeming();
      } catch (err) {
        logger.error(`[CRON ERROR] voucher stale-lock sweep: ${(err as Error).message}`);
      }
      try {
        await checkBurnerGas();
      } catch (err) {
        logger.error(`[CRON ERROR] burner gas check: ${(err as Error).message}`);
      }
    },
    tz,
  );
}
