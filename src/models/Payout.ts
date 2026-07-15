import mongoose, { Schema, Document } from 'mongoose';

export interface IPayoutBreakdownEntry {
  symbol: string;
  tokenAddress: string;
  amount: number;
  txHash?: string;
  status: 'PAID' | 'FAILED';
}

export interface IPayout extends Document {
  walletAddress: string;
  username: string;
  rank: string;
  amountUSDC: number; // total value across every stablecoin paid out, treated ~1:1 with USD
  shares: number;
  txHash?: string; // kept for backward compat: mirrors breakdown[0].txHash
  breakdown: IPayoutBreakdownEntry[]; // one entry per token actually transferred (USDT and/or USDC)
  month: string; // Storing as YYYY-MM
  status: 'PENDING' | 'PAID' | 'FAILED';
  createdAt: Date;
}

const PayoutBreakdownSchema = new Schema<IPayoutBreakdownEntry>(
  {
    symbol: { type: String, required: true },
    tokenAddress: { type: String, required: true },
    amount: { type: Number, required: true },
    txHash: { type: String },
    status: { type: String, enum: ['PAID', 'FAILED'], required: true },
  },
  { _id: false },
);

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
  breakdown: {
    type: [PayoutBreakdownSchema],
    default: [],
  },
  month: {
    type: String,
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['PENDING', 'PAID', 'FAILED'],
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
