import mongoose, { Schema, Document } from 'mongoose';

export interface ICoinGeckoCache extends Document {
  /** Normalized path including query string (unique cache key). */
  key: string;
  path: string;
  statusCode: number;
  body: unknown;
  fetchedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CoinGeckoCacheSchema: Schema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    path: {
      type: String,
      required: true,
    },
    statusCode: {
      type: Number,
      required: true,
      default: 200,
    },
    body: {
      type: Schema.Types.Mixed,
      required: true,
    },
    fetchedAt: {
      type: Date,
      required: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

export default mongoose.model<ICoinGeckoCache>('CoinGeckoCache', CoinGeckoCacheSchema);
