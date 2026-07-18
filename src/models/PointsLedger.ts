import mongoose, { Schema, Document } from 'mongoose';

export type PointsSource =
  | 'MEMBERSHIP_PURCHASE'
  | 'MEMBERSHIP_UPGRADE'
  | 'COMMISSION_EARNED'
  | 'POOL_DEPOSIT';

export interface IPointsLedger extends Document {
  walletAddress: string;
  amount: number; // points awarded
  source: PointsSource;
  usdValue: number; // USD amount that generated the points
  txHash?: string;
  timestamp: Date;
}

const PointsLedgerSchema: Schema = new Schema({
  walletAddress: {
    type: String,
    required: true,
    index: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  source: {
    type: String,
    enum: ['MEMBERSHIP_PURCHASE', 'MEMBERSHIP_UPGRADE', 'COMMISSION_EARNED', 'POOL_DEPOSIT'],
    required: true,
  },
  usdValue: {
    type: Number,
    required: true,
  },
  txHash: {
    type: String,
    index: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

// Prevent double-counting when the same event is reprocessed.
PointsLedgerSchema.index(
  { txHash: 1, walletAddress: 1, source: 1 },
  { unique: true, sparse: true },
);

export default mongoose.model<IPointsLedger>('PointsLedger', PointsLedgerSchema);
