import mongoose, { Schema, Document } from 'mongoose';

/**
 * Promo credit an issuer can spend on vouchers. One document per (wallet, token).
 * Token is stored as the SYMBOL, not an ERC20 address: no token ever moves, so
 * binding it to an address would imply a redeemability that does not exist
 * (`AchievementBonus` sets the same precedent of carrying a bare symbol).
 *
 * `balance` is denormalized. The authoritative decrement is the conditional
 * atomic update `{ balance: { $gte: amount } }` in VoucherService — `min: 0`
 * here is only a validator, not the guarantee. `recalculateBalance` rebuilds
 * this value from the VoucherLedger sum.
 */
export interface IVoucherBalance extends Document {
  walletAddress: string;
  token: 'USDT' | 'USDC';
  balance: number; // available to issue
  issued: number; // lifetime debited by issuance
  refunded: number; // lifetime returned by expiry/revoke
  creditedTotal: number; // lifetime admin credits
  debitedTotal: number; // lifetime admin debits
  updatedAt: Date;
  createdAt: Date;
}

const VoucherBalanceSchema: Schema = new Schema(
  {
    walletAddress: { type: String, required: true, lowercase: true, index: true },
    token: { type: String, enum: ['USDT', 'USDC'], required: true },
    balance: { type: Number, default: 0, min: 0 },
    issued: { type: Number, default: 0 },
    refunded: { type: Number, default: 0 },
    creditedTotal: { type: Number, default: 0 },
    debitedTotal: { type: Number, default: 0 },
  },
  { timestamps: true },
);

VoucherBalanceSchema.index({ walletAddress: 1, token: 1 }, { unique: true });

export default mongoose.model<IVoucherBalance>('VoucherBalance', VoucherBalanceSchema);
