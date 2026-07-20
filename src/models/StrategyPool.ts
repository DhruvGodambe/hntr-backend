import mongoose, { Schema, Document } from 'mongoose';

export interface IStrategyPool extends Document {
  slug: string;
  name: string;
  imageUrl: string;
  targetEth: number;
  raisedEth: number;
  status: 'OPEN' | 'CLOSED' | 'COMPLETED';
  depositsPaused: boolean;
  collectionName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const StrategyPoolSchema: Schema = new Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      maxlength: 80,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    imageUrl: {
      type: String,
      default: '/assets/images/pool-default.jpg',
      maxlength: 512,
    },
    targetEth: {
      type: Number,
      required: true,
      min: 0.01,
    },
    raisedEth: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ['OPEN', 'CLOSED', 'COMPLETED'],
      default: 'OPEN',
      index: true,
    },
    depositsPaused: {
      type: Boolean,
      default: false,
    },
    collectionName: {
      type: String,
      trim: true,
      maxlength: 120,
    },
  },
  { timestamps: true },
);

export default mongoose.model<IStrategyPool>('StrategyPool', StrategyPoolSchema);
