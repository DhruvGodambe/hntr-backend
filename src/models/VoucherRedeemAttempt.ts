import mongoose, { Schema, Document } from 'mongoose';

/**
 * Persisted brute-force lockout for the bearer-code redeem endpoint. Unlike the
 * in-memory rateLimiter middleware, this survives a restart. Keyed per wallet
 * and per IP; a row is only written on a FAILED attempt.
 */
export interface IVoucherRedeemAttempt extends Document {
  key: string; // "wallet:0x…" or "ip:1.2.3.4"
  failures: number;
  windowStart: Date;
  lockedUntil?: Date;
  lastAttempt: Date;
}

const VoucherRedeemAttemptSchema: Schema = new Schema({
  key: { type: String, required: true, unique: true },
  failures: { type: Number, default: 0 },
  windowStart: { type: Date, default: Date.now },
  lockedUntil: { type: Date },
  lastAttempt: { type: Date, default: Date.now },
});

// Auto-clean rows that have been idle for a day.
VoucherRedeemAttemptSchema.index({ lastAttempt: 1 }, { expireAfterSeconds: 86400 });

export default mongoose.model<IVoucherRedeemAttempt>(
  'VoucherRedeemAttempt',
  VoucherRedeemAttemptSchema,
);
