import mongoose, { Schema, Document } from 'mongoose';

export interface IAdminAccount extends Document {
  username: string;
  passwordHash: string;
  isActive: boolean;
  failedLoginAttempts: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date | null;
  totpEnabled: boolean;
  totpSecret?: string | null;
  totpPendingSecret?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const AdminAccountSchema: Schema = new Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 32,
      index: true,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },
    lockedUntil: {
      type: Date,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    totpEnabled: {
      type: Boolean,
      default: false,
    },
    // Active TOTP secret (base32). Only present once 2FA is confirmed.
    totpSecret: {
      type: String,
      default: null,
      select: false,
    },
    // Candidate secret during setup, before the first valid code confirms it.
    totpPendingSecret: {
      type: String,
      default: null,
      select: false,
    },
  },
  { timestamps: true },
);

export default mongoose.model<IAdminAccount>('AdminAccount', AdminAccountSchema);
