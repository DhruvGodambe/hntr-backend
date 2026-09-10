import mongoose, { Schema, Document, Types } from 'mongoose';

export type DisbursementBatchType = 'LEADERSHIP' | 'RANK' | 'ACHIEVEMENT';
export type DisbursementBatchStatus =
  | 'FUNDING'
  | 'DISPERSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'PARTIAL';

export interface IFundTransfer {
  token: string;
  tokenAddress: string;
  amountRaw: string;
  amount: number;
  txHash: string;
}

export interface IDispersalEntry {
  username: string;
  walletAddress: string;
  rank?: string;
  token: string;
  tokenAddress: string;
  amountRaw: string;
  amount: number;
  txHash?: string;
  status: 'PAID' | 'FAILED' | 'PENDING';
  bonusId?: string;
}

export interface IDisbursementBatch extends Document {
  type: DisbursementBatchType;
  month?: string;
  status: DisbursementBatchStatus;
  triggeredBy: string;
  protocolWallet: string;
  burnerWallet: string;
  fundTransfers: IFundTransfer[];
  dispersals: IDispersalEntry[];
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const FundTransferSchema = new Schema<IFundTransfer>(
  {
    token: { type: String, required: true },
    tokenAddress: { type: String, required: true },
    amountRaw: { type: String, required: true },
    amount: { type: Number, required: true },
    txHash: { type: String, required: true },
  },
  { _id: false },
);

const DispersalEntrySchema = new Schema<IDispersalEntry>(
  {
    username: { type: String, required: true },
    walletAddress: { type: String, required: true },
    rank: { type: String },
    token: { type: String, required: true },
    tokenAddress: { type: String, required: true },
    amountRaw: { type: String, required: true },
    amount: { type: Number, required: true },
    txHash: { type: String },
    status: { type: String, enum: ['PAID', 'FAILED', 'PENDING'], required: true },
    bonusId: { type: String },
  },
  { _id: false },
);

const DisbursementBatchSchema: Schema = new Schema(
  {
    type: {
      type: String,
      enum: ['LEADERSHIP', 'RANK', 'ACHIEVEMENT'],
      required: true,
      index: true,
    },
    month: {
      type: String,
      index: true,
    },
    status: {
      type: String,
      enum: ['FUNDING', 'DISPERSING', 'COMPLETED', 'FAILED', 'PARTIAL'],
      default: 'FUNDING',
      index: true,
    },
    triggeredBy: {
      type: String,
      required: true,
    },
    protocolWallet: {
      type: String,
      required: true,
      lowercase: true,
    },
    burnerWallet: {
      type: String,
      required: true,
      lowercase: true,
    },
    fundTransfers: {
      type: [FundTransferSchema],
      default: [],
    },
    dispersals: {
      type: [DispersalEntrySchema],
      default: [],
    },
    error: {
      type: String,
    },
  },
  { timestamps: true },
);

DisbursementBatchSchema.index({ type: 1, month: 1, createdAt: -1 });

export type DisbursementBatchId = Types.ObjectId;

export default mongoose.model<IDisbursementBatch>('DisbursementBatch', DisbursementBatchSchema);
