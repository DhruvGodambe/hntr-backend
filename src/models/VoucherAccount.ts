import mongoose, { Schema, Document } from 'mongoose';

/**
 * Voucher-page access control — one document per wallet, kept separate from
 * VoucherBalance so the enable/disable toggle is a single-document write
 * independent of any token bucket. Rows are created lazily by an admin against
 * an existing User (never an arbitrary address).
 */
export interface IVoucherAccount extends Document {
  walletAddress: string;
  username: string;
  enabled: boolean;
  enabledAt?: Date;
  enabledBy?: string;
  disabledAt?: Date;
  disabledBy?: string;
  disabledReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const VoucherAccountSchema: Schema = new Schema(
  {
    walletAddress: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      index: true,
    },
    username: { type: String, required: true, index: true },
    enabled: { type: Boolean, default: false, index: true },
    enabledAt: { type: Date },
    enabledBy: { type: String },
    disabledAt: { type: Date },
    disabledBy: { type: String },
    disabledReason: { type: String, maxlength: 256 },
  },
  { timestamps: true },
);

export default mongoose.model<IVoucherAccount>('VoucherAccount', VoucherAccountSchema);
