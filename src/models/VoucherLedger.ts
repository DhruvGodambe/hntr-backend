import mongoose, { Schema, Document } from 'mongoose';

export type VoucherLedgerReason =
  | 'ADMIN_CREDIT'
  | 'ADMIN_DEBIT'
  | 'VOUCHER_ISSUE'
  | 'VOUCHER_EXPIRY_REFUND'
  | 'VOUCHER_REVOKE_REFUND'
  | 'RECONCILE_ADJUSTMENT';

/**
 * Append-only balance ledger, modelled on PointsLedger. Every VoucherBalance
 * mutation writes one row here first-or-alongside, keyed by a stable `entryKey`
 * that is unique per (wallet, entryKey) — this is the idempotency guarantee that
 * makes credit/debit/issue/refund safe to retry.
 *
 * entryKey catalogue:
 *   ADMIN_CREDIT / ADMIN_DEBIT      -> `ADMIN:<voucherAdminAuditId>`
 *   VOUCHER_ISSUE                   -> `VOUCHER_ISSUE:<voucherId>`
 *   VOUCHER_EXPIRY_REFUND          -> `VOUCHER_EXPIRY_REFUND:<voucherId>`
 *   VOUCHER_REVOKE_REFUND         -> `VOUCHER_REVOKE_REFUND:<voucherId>`
 *   RECONCILE_ADJUSTMENT           -> `RECONCILE:<isoTimestamp>`
 */
export interface IVoucherLedger extends Document {
  walletAddress: string;
  token: 'USDT' | 'USDC';
  entryKey: string;
  delta: number; // signed
  balanceAfter: number; // captured from the atomic update's {new:true} result
  reason: VoucherLedgerReason;
  voucherId?: string;
  adminUsername?: string;
  note?: string;
  timestamp: Date;
}

const VoucherLedgerSchema: Schema = new Schema({
  walletAddress: { type: String, required: true, lowercase: true, index: true },
  token: { type: String, enum: ['USDT', 'USDC'], required: true },
  entryKey: { type: String, required: true },
  delta: { type: Number, required: true },
  balanceAfter: { type: Number, required: true },
  reason: {
    type: String,
    enum: [
      'ADMIN_CREDIT',
      'ADMIN_DEBIT',
      'VOUCHER_ISSUE',
      'VOUCHER_EXPIRY_REFUND',
      'VOUCHER_REVOKE_REFUND',
      'RECONCILE_ADJUSTMENT',
    ],
    required: true,
  },
  voucherId: { type: String, index: true, sparse: true },
  adminUsername: { type: String },
  note: { type: String, maxlength: 256 },
  timestamp: { type: Date, default: Date.now, index: true },
});

VoucherLedgerSchema.index({ walletAddress: 1, entryKey: 1 }, { unique: true });
VoucherLedgerSchema.index({ walletAddress: 1, token: 1, timestamp: -1 });

export default mongoose.model<IVoucherLedger>('VoucherLedger', VoucherLedgerSchema);
