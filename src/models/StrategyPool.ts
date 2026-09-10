import mongoose, { Schema, Document } from 'mongoose';

export const DEFAULT_SEAPORT_PROTOCOL_ADDRESS = '0x0000000000000068F116a894984e2DB1123eB395';

export interface IStrategyPoolOpenSea {
  collectionSlug: string;
  contractAddress?: string;
  chain: string;
  tokenStandard?: 'erc721' | 'erc1155';
  protocolAddress?: string;
  trait?: { type: string; value: string };
  offerProtectionEnabled?: boolean;
}

export interface IStrategyPool extends Document {
  slug: string;
  name: string;
  imageUrl: string;
  raisedEth: number;
  status: 'OPEN' | 'CLOSED' | 'COMPLETED';
  depositsPaused: boolean;
  collectionName?: string;
  openSea?: IStrategyPoolOpenSea;
  gpProfit?: string;
  ethProfit?: string;
  usdtProfit?: string;
  participants?: number;
  daysRemaining?: number;
  tags?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const OpenSeaSchema = new Schema<IStrategyPoolOpenSea>(
  {
    collectionSlug: { type: String, trim: true, maxlength: 120 },
    contractAddress: { type: String, trim: true, maxlength: 64 },
    chain: { type: String, trim: true, maxlength: 40, default: 'ethereum' },
    tokenStandard: { type: String, enum: ['erc721', 'erc1155'] },
    protocolAddress: { type: String, trim: true, maxlength: 64, default: DEFAULT_SEAPORT_PROTOCOL_ADDRESS },
    trait: {
      type: new Schema(
        {
          type: { type: String, trim: true, maxlength: 120 },
          value: { type: String, trim: true, maxlength: 200 },
        },
        { _id: false },
      ),
      required: false,
    },
    offerProtectionEnabled: { type: Boolean, default: true },
  },
  { _id: false },
);

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
    openSea: { type: OpenSeaSchema, required: false },
    gpProfit: { type: String, trim: true, maxlength: 40 },
    ethProfit: { type: String, trim: true, maxlength: 40 },
    usdtProfit: { type: String, trim: true, maxlength: 40 },
    participants: { type: Number, min: 0 },
    daysRemaining: { type: Number, min: 0 },
    tags: { type: [String], default: undefined },
  },
  { timestamps: true },
);

StrategyPoolSchema.index({ 'openSea.collectionSlug': 1 });

export default mongoose.model<IStrategyPool>('StrategyPool', StrategyPoolSchema);
