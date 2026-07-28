import mongoose, { Schema, Document } from 'mongoose';

export interface ITransaction extends Document {
  txHash?: string;
  walletAddress: string;
  type: 'PURCHASE' | 'UPGRADE' | 'COMMISSION_CLAIM' | 'COMMISSION_EARNED' | 'COMMISSION_WITHDRAWN' | 'COMPANY_WALLET_WITHDRAWN';
  tier?: string;
  token?: string;
  amount: number; // total for COMMISSION_EARNED, withdrawn amount for COMMISSION_WITHDRAWN / COMPANY_WALLET_WITHDRAWN
  liquidAmount?: number; // 80% of the commission (claimable part)
  lockedAmount?: number; // 20% of the commission (locked / pool-wallet part)
  level?: number; // referral level for COMMISSION_EARNED (1-12)
  /** Wallet that purchased/upgraded and triggered this commission (same tx). */
  sourceWalletAddress?: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  errorMessage?: string;
  timestamp: Date;
}

const TransactionSchema: Schema = new Schema({
  txHash: {
    type: String,
    // Not required: a PENDING relay record is created before the tx is broadcast
    // and does not have a hash yet. No longer unique here because a single tx can
    // emit multiple events (e.g. MembershipPurchased + several CommissionEarned).
    index: true,
  },
  walletAddress: {
    type: String,
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: ['PURCHASE', 'UPGRADE', 'COMMISSION_CLAIM', 'COMMISSION_EARNED', 'COMMISSION_WITHDRAWN', 'COMPANY_WALLET_WITHDRAWN'],
    required: true,
  },
  tier: {
    type: String, // e.g., "Bronze"
  },
  token: {
    type: String,
  },
  amount: {
    type: Number,
    required: true,
  },
  liquidAmount: {
    type: Number,
  },
  lockedAmount: {
    type: Number,
  },
  level: {
    type: Number,
  },
  sourceWalletAddress: {
    type: String,
    index: true,
  },
  status: {
    type: String,
    enum: ['PENDING', 'CONFIRMED', 'FAILED'],
    default: 'CONFIRMED', // the on-chain event listener always inserts already-confirmed rows
  },
  errorMessage: {
    type: String,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

// A single transaction can emit multiple events for different wallets/levels/tokens,
// so uniqueness is enforced on the combined key rather than txHash alone.
// Partial (not sparse): compound sparse indexes still include docs that have any of
// the other keys, so PENDING/FAILED relay stubs with txHash:null collided on
// {null, wallet, type, token, null} and blocked claim retries (E11000).
TransactionSchema.index(
  { txHash: 1, walletAddress: 1, type: 1, token: 1, level: 1 },
  {
    unique: true,
    partialFilterExpression: { txHash: { $type: 'string' } },
  },
);

// Prevent a second PURCHASE/UPGRADE/COMMISSION_CLAIM relay from being submitted for the same wallet
// while one is still in flight (e.g. a double-click, or a retried request racing a
// backend restart).
TransactionSchema.index(
  { walletAddress: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'PENDING' },
  },
);

export default mongoose.model<ITransaction>('Transaction', TransactionSchema);
