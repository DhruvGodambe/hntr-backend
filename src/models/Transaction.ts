import mongoose, { Schema, Document } from 'mongoose';

export interface ITransaction extends Document {
  txHash?: string;
  walletAddress: string;
  type: 'PURCHASE' | 'UPGRADE' | 'COMMISSION_CLAIM' | 'COMMISSION_EARNED' | 'COMMISSION_WITHDRAWN';
  tier?: string;
  token?: string;
  amount: number; // total for COMMISSION_EARNED, withdrawn amount for COMMISSION_WITHDRAWN
  liquidAmount?: number; // 80% of the commission (claimable part)
  lockedAmount?: number; // 20% of the commission (locked / pool-wallet part)
  level?: number; // referral level for COMMISSION_EARNED (1-12)
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  errorMessage?: string;
  timestamp: Date;
}

const TransactionSchema: Schema = new Schema({
  txHash: {
    type: String,
    // Not required: a PENDING relay record is created before the tx is broadcast
    // and does not have a hash yet. `sparse` lets many docs share a missing txHash
    // while still enforcing uniqueness once one is set.
    unique: true,
    sparse: true,
    index: true,
  },
  walletAddress: {
    type: String,
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: ['PURCHASE', 'UPGRADE', 'COMMISSION_CLAIM', 'COMMISSION_EARNED', 'COMMISSION_WITHDRAWN'],
    required: true,
  },
  tier: {
    type: String, // e.g., "Scout"
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
