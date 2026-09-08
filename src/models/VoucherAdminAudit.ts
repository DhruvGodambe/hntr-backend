import mongoose, { Schema, Document } from 'mongoose';

export type VoucherAdminAction =
  | 'ENABLE_ACCESS'
  | 'DISABLE_ACCESS'
  | 'CREDIT_BALANCE'
  | 'DEBIT_BALANCE'
  | 'REVOKE_VOUCHER'
  | 'SET_BURNER_WALLET'
  | 'RECONCILE_BALANCE'
  | 'REVIEW_ACHIEVEMENT_BONUS';

/**
 * Admin action trail for voucher operations. Balance moves are also in
 * VoucherLedger, but access toggles / revocations / burner rotation have no
 * balance delta and still need an audit record. Balance mutations write this
 * row FIRST, then use `ADMIN:<thisId>` as the ledger entryKey — which makes the
 * idempotency key naturally unique per admin action and links the two tables.
 */
export interface IVoucherAdminAudit extends Document {
  adminUsername: string;
  action: VoucherAdminAction;
  targetWallet?: string;
  targetUsername?: string;
  voucherId?: string;
  token?: 'USDT' | 'USDC';
  delta?: number;
  txHash?: string; // for SET_BURNER_WALLET
  reason?: string;
  createdAt: Date;
}

const VoucherAdminAuditSchema: Schema = new Schema({
  adminUsername: { type: String, required: true, index: true },
  action: {
    type: String,
    enum: [
      'ENABLE_ACCESS',
      'DISABLE_ACCESS',
      'CREDIT_BALANCE',
      'DEBIT_BALANCE',
      'REVOKE_VOUCHER',
      'SET_BURNER_WALLET',
      'RECONCILE_BALANCE',
      'REVIEW_ACHIEVEMENT_BONUS',
    ],
    required: true,
    index: true,
  },
  targetWallet: { type: String, lowercase: true, index: true },
  targetUsername: { type: String },
  voucherId: { type: String },
  token: { type: String, enum: ['USDT', 'USDC'] },
  delta: { type: Number },
  txHash: { type: String },
  reason: { type: String, maxlength: 256 },
  createdAt: { type: Date, default: Date.now, index: true },
});

export default mongoose.model<IVoucherAdminAudit>('VoucherAdminAudit', VoucherAdminAuditSchema);
