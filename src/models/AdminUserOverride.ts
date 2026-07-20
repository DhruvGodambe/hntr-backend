import mongoose, { Schema, Document } from 'mongoose';

export interface IAdminUserOverride extends Document {
  username: string;
  isBlocked: boolean;
  tierOverride?: string | null;
  rankOverride?: string | null;
  blockedReason?: string;
  updatedAt: Date;
  createdAt: Date;
}

const AdminUserOverrideSchema: Schema = new Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
    },
    isBlocked: {
      type: Boolean,
      default: false,
      index: true,
    },
    tierOverride: {
      type: String,
      enum: ['None', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', null],
      default: null,
    },
    rankOverride: {
      type: String,
      enum: [
        'None',
        'Scout',
        'Tracker',
        'Ranger',
        'Hunter',
        'Elite Hunter',
        'Master Hunter',
        'Legend Hunter',
        null,
      ],
      default: null,
    },
    blockedReason: {
      type: String,
      maxlength: 256,
    },
  },
  { timestamps: true },
);

export default mongoose.model<IAdminUserOverride>('AdminUserOverride', AdminUserOverrideSchema);
