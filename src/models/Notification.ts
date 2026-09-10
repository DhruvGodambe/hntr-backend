import mongoose, { Schema, Document } from 'mongoose';

export type NotificationType =
  | 'COMMISSION_EARNED'
  | 'COMMISSION_CLAIMED'
  | 'MEMBERSHIP_PURCHASED'
  | 'MEMBERSHIP_UPGRADED'
  | 'LEADERSHIP_PAYOUT'
  | 'ACHIEVEMENT_PAYOUT'
  | 'RANK_UP'
  | 'VOUCHER_RECEIVED'
  | 'VOUCHER_REDEEMED'
  | 'VOUCHER_CLAIMED_BY_OTHER'
  | 'GENERAL';

export interface INotification extends Document {
  walletAddress: string;
  type: NotificationType;
  title: string;
  sub: string;
  link?: string;
  meta?: Record<string, unknown>;
  /**
   * Optional idempotency key. When set, at most one notification with the same
   * (walletAddress, dedupeKey) is ever stored — used for events that can be
   * delivered more than once (chain-event replay, overlapping volume recalcs)
   * but must notify the user exactly once, e.g. reaching a given rank.
   */
  dedupeKey?: string;
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
      'VOUCHER_RECEIVED',
      'VOUCHER_REDEEMED',
      'VOUCHER_CLAIMED_BY_OTHER',
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
  dedupeKey: {
    type: String,
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
// Race-safe idempotency: a duplicate event delivery hits E11000 instead of
// inserting a second identical notification. Only rows that set dedupeKey are
// indexed, so legacy notifications are unaffected.
NotificationSchema.index(
  { walletAddress: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);

export default mongoose.model<INotification>('Notification', NotificationSchema);
