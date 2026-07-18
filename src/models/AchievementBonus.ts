import mongoose, { Schema, Document } from 'mongoose';

export interface IAchievementBonus extends Document {
  walletAddress: string;
  username: string;
  rank: string;
  amountUSD: number;
  status: 'PENDING' | 'PAID' | 'FAILED';
  token?: string;
  tokenAddress?: string;
  txHash?: string;
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
    enum: ['PENDING', 'PAID', 'FAILED'],
    default: 'PENDING',
    index: true,
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
