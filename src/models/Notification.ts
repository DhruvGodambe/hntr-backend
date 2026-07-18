import mongoose, { Schema, Document } from 'mongoose';

export type NotificationType =
  | 'COMMISSION_EARNED'
  | 'COMMISSION_CLAIMED'
  | 'MEMBERSHIP_PURCHASED'
  | 'MEMBERSHIP_UPGRADED'
  | 'LEADERSHIP_PAYOUT'
  | 'ACHIEVEMENT_PAYOUT'
  | 'RANK_UP'
  | 'GENERAL';

export interface INotification extends Document {
  walletAddress: string;
  type: NotificationType;
  title: string;
  sub: string;
  link?: string;
  meta?: Record<string, unknown>;
  read: boolean;
  createdAt: Date;
}

const NotificationSchema: Schema = new Schema({
  walletAddress: {
    type: String,
    required: true,
    index: true,
    lowercase: true,
  },
  type: {
    type: String,
    enum: [
      'COMMISSION_EARNED',
      'COMMISSION_CLAIMED',
      'MEMBERSHIP_PURCHASED',
      'MEMBERSHIP_UPGRADED',
      'LEADERSHIP_PAYOUT',
      'ACHIEVEMENT_PAYOUT',
      'RANK_UP',
      'GENERAL',
    ],
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  sub: {
    type: String,
    required: true,
  },
  link: {
    type: String,
  },
  meta: {
    type: Schema.Types.Mixed,
  },
  read: {
    type: Boolean,
    default: false,
    index: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

NotificationSchema.index({ walletAddress: 1, createdAt: -1 });

export default mongoose.model<INotification>('Notification', NotificationSchema);
