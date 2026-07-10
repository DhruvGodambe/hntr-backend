import mongoose, { Schema, Document } from 'mongoose';

export interface ITransaction extends Document {
  txHash: string;
  walletAddress: string;
  type: 'PURCHASE' | 'UPGRADE' | 'COMMISSION_CLAIM';
  tier?: string;
  amount: number;
  timestamp: Date;
}

const TransactionSchema: Schema = new Schema({
  txHash: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  walletAddress: {
    type: String,
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: ['PURCHASE', 'UPGRADE', 'COMMISSION_CLAIM'],
    required: true,
  },
  tier: {
    type: String, // e.g., "Scout"
  },
  amount: {
    type: Number,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model<ITransaction>('Transaction', TransactionSchema);
