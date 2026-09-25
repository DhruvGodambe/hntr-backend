import mongoose, { Schema, Document } from 'mongoose';

export interface ILeadershipPoolTokenSnapshot {
  symbol: 'USDT' | 'USDC';
  address: string;
  decimals: number;
  rawBalance: string;
}

export interface ILeadershipPoolSnapshot extends Document {
  month: string;
  tokens: ILeadershipPoolTokenSnapshot[];
  capturedAt: Date;
}

const TokenSnapshotSchema = new Schema<ILeadershipPoolTokenSnapshot>(
  {
    symbol: { type: String, enum: ['USDT', 'USDC'], required: true },
    address: { type: String, required: true },
    decimals: { type: Number, required: true },
    rawBalance: { type: String, required: true },
  },
  { _id: false },
);

// Locks the leadership wallet's stablecoin balance the first time it is read for a
// given month, so the pro-rata payout split stays consistent between the admin
// preview and the actual distribution even after the admin moves funds out to the
// burner wallet for payment (which would otherwise shrink the reference balance
// mid-run and shortchange recipients).
const LeadershipPoolSnapshotSchema: Schema = new Schema(
  {
    month: {
      type: String,
      required: true,
      unique: true,
    },
    tokens: {
      type: [TokenSnapshotSchema],
      required: true,
    },
    capturedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { timestamps: true },
);

export default mongoose.model<ILeadershipPoolSnapshot>(
  'LeadershipPoolSnapshot',
  LeadershipPoolSnapshotSchema,
);
