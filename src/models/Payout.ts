import mongoose, { Schema, Document } from 'mongoose';

export interface IPayout extends Document {
  walletAddress: string;
  username: string;
  rank: string;
  amountUSDC: number;
  shares: number;
  txHash?: string;
  month: string; // Storing as YYYY-MM
  status: 'PENDING' | 'PAID';
  createdAt: Date;
}

const PayoutSchema: Schema = new Schema({
  walletAddress: {
    type: String,
    required: true,
    index: true,
  },
  username: {
    type: String,
    required: true,
  },
  rank: {
    type: String,
    required: true,
  },
  amountUSDC: {
    type: Number,
    required: true,
  },
  shares: {
    type: Number,
    required: true,
  },
  txHash: {
    type: String,
  },
  month: {
    type: String,
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['PENDING', 'PAID'],
    default: 'PENDING',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Ensure a user only gets one leadership payout per month
PayoutSchema.index({ username: 1, month: 1 }, { unique: true });

export default mongoose.model<IPayout>('Payout', PayoutSchema);
