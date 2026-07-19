import mongoose, { Schema, Document } from 'mongoose';

export type PointsSource =
  | 'MEMBERSHIP_PURCHASE'
  | 'MEMBERSHIP_UPGRADE'
  | 'COMMISSION_EARNED'
  | 'POOL_DEPOSIT';

export interface IPointsLedger extends Document {
  walletAddress: string;
  /** Stable idempotency key: source:txHash or source:txHash:Llevel:token */
  entryKey: string;
  amount: number;
  source: PointsSource;
  usdValue: number;
  txHash?: string;
  level?: number;
  timestamp: Date;
}

const PointsLedgerSchema: Schema = new Schema({
  walletAddress: {
    type: String,
    required: true,
    index: true,
  },
  entryKey: {
    type: String,
    required: true,
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
  level: {
    type: Number,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

// Primary idempotency key for awards + reconciliation.
PointsLedgerSchema.index({ walletAddress: 1, entryKey: 1 }, { unique: true });

export default mongoose.model<IPointsLedger>('PointsLedger', PointsLedgerSchema);
