import mongoose, { Schema, Document } from 'mongoose';

export interface IAchievementBonus extends Document {
  walletAddress: string;
  username: string;
  rank: string;
  amountUSD: number;
  /**
   * PENDING       — eligible for admin Distribute Rank Bonuses (two-hop via burner).
   * PENDING_REVIEW — qualified while voucher-granted volume was in the downline;
   *                  held for manual admin approval (moves to PENDING on approve).
   * REJECTED      — admin declined; never pays out.
   */
  status: 'PENDING' | 'PENDING_REVIEW' | 'PAID' | 'FAILED' | 'REJECTED';
  reviewReason?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  token?: string;
  tokenAddress?: string;
  txHash?: string;
  /** DisbursementBatch id for the admin two-hop run that paid this bonus. */
  batchId?: string;
  createdAt: Date;
  paidAt?: Date;
}

const AchievementBonusSchema: Schema = new Schema({
  walletAddress: {
    type: String,
    required: true,
    index: true,
    lowercase: true,
  },
  username: {
    type: String,
    required: true,
  },
  rank: {
    type: String,
    required: true,
  },
  amountUSD: {
    type: Number,
    required: true,
  },
  status: {
    type: String,
    enum: ['PENDING', 'PENDING_REVIEW', 'PAID', 'FAILED', 'REJECTED'],
    default: 'PENDING',
    index: true,
  },
  reviewReason: {
    type: String,
    maxlength: 512,
  },
  reviewedBy: {
    type: String,
  },
  reviewedAt: {
    type: Date,
  },
  token: {
    type: String,
  },
  tokenAddress: {
    type: String,
  },
  txHash: {
    type: String,
  },
  batchId: {
    type: String,
    index: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  paidAt: {
    type: Date,
  },
});

// One-time bonus per wallet per rank
AchievementBonusSchema.index({ walletAddress: 1, rank: 1 }, { unique: true });

export default mongoose.model<IAchievementBonus>('AchievementBonus', AchievementBonusSchema);
