import mongoose, { Schema, Document } from 'mongoose';

export type PriorityLineStatus = 'ACTIVE' | 'WITHDRAWAL_REQUESTED' | 'WITHDRAWN' | 'REVIEW';

export interface IPriorityLineDeposit extends Document {
  walletAddress: string;
  /**
   * Ordering ticket in the line (live position = rank among in-line tickets). Unset for REVIEW
   * deposits. Always a whole number. Normally the next counter value; a deposit recorded late takes
   * the ticket of the first deposit sent after it, and that ticket and all later ones move up by one.
   */
  lineNumber?: number;
  token: 'USDT' | 'USDC';
  amountUsd: number;
  amountRaw: string;
  txHash: string;
  logIndex: number;
  /** Block time of the transfer; orders the line. Older rows may lack it (createdAt is the fallback). */
  txTimestamp?: Date;
  /** Deposit wallet the funds were sent to. */
  depositWallet: string;
  status: PriorityLineStatus;
  withdrawalRequestedAt?: Date;
  withdrawnAt?: Date;
  processedBy?: string;
  payoutTxHash?: string;
  adminNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PriorityLineDepositSchema: Schema = new Schema(
  {
    walletAddress: { type: String, required: true, lowercase: true, index: true },
    lineNumber: { type: Number },
    token: { type: String, enum: ['USDT', 'USDC'], required: true },
    amountUsd: { type: Number, required: true },
    amountRaw: { type: String, required: true },
    txHash: { type: String, required: true, lowercase: true },
    logIndex: { type: Number, required: true },
    txTimestamp: { type: Date },
    depositWallet: { type: String, required: true, lowercase: true },
    status: {
      type: String,
      enum: ['ACTIVE', 'WITHDRAWAL_REQUESTED', 'WITHDRAWN', 'REVIEW'],
      default: 'ACTIVE',
      index: true,
    },
    withdrawalRequestedAt: { type: Date },
    withdrawnAt: { type: Date },
    processedBy: { type: String },
    payoutTxHash: { type: String, lowercase: true },
    adminNote: { type: String, maxlength: 512 },
  },
  { timestamps: true },
);

// Replay protection: one on-chain transfer can only ever be credited once.
PriorityLineDepositSchema.index({ txHash: 1, logIndex: 1 }, { unique: true });
// Line numbers are unique where set (REVIEW rows have none).
PriorityLineDepositSchema.index(
  { lineNumber: 1 },
  { unique: true, partialFilterExpression: { lineNumber: { $type: 'number' } } },
);
PriorityLineDepositSchema.index({ walletAddress: 1, createdAt: -1 });

export default mongoose.model<IPriorityLineDeposit>('PriorityLineDeposit', PriorityLineDepositSchema);
