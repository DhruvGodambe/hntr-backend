import mongoose, { Schema, Document } from 'mongoose';

export type UserAccountType = 'member' | 'admin';

export interface IUser extends Document {
  username: string;
  /** Empty for the system admin root (no linked wallet). */
  walletAddress: string;
  type: UserAccountType;
  email?: string;
  phone?: string;
  sponsorUsername?: string | null;
  ancestors: string[];
  directDownline: string[];
  tier: 'None' | 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond';
  rank: 'None' | 'Scout' | 'Tracker' | 'Ranger' | 'Hunter' | 'Elite Hunter' | 'Master Hunter' | 'Legend Hunter';
  /**
   * True when an admin forced this user's display rank above (or onto) a rank
   * they have not yet earned by volume. Achievement bonuses for the forced rank
   * and intermediates stay withheld until volume qualifies.
   */
  isForcedRank: boolean;
  /**
   * True when company/admin set membership tier on-chain via free override
   * (overrideMembershipTier) rather than a paid purchase/upgrade.
   * Cleared on a subsequent paid MembershipUpgraded.
   */
  isForcedMembership: boolean;
  /**
   * True when the current tier came from redeeming a bearer voucher (no payment,
   * no commissions). Same lifecycle as isForcedMembership — cleared on a
   * subsequent paid MembershipPurchased/MembershipUpgraded. Used by the
   * achievement-bonus review gate: a rank qualified while voucher volume is in
   * the downline is held for manual approval instead of auto-paying.
   */
  isVoucherMembership: boolean;
  teamVolume: number;
  legVolumes: Map<string, number>;
  hntrPoints: number;
  joinedAt: Date;
}

const UserSchema: Schema = new Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  walletAddress: {
    type: String,
    // Admin root has no wallet; members still set a unique address at register.
    required: false,
    default: '',
    unique: true,
    sparse: true,
    index: true,
  },
  type: {
    type: String,
    enum: ['member', 'admin'],
    default: 'member',
    index: true,
  },
  email: {
    type: String,
  },
  phone: {
    type: String,
  },
  sponsorUsername: {
    type: String,
    default: null, // null for root user
  },
  ancestors: {
    type: [String],
    default: [], // e.g., ["root", "sponsorA", "sponsorB"]
    index: true, // index for fast downline queries
  },
  directDownline: {
    type: [String],
    default: [], // List of usernames directly sponsored by this user
  },
  tier: {
    type: String,
    enum: ['None', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'],
    default: 'None',
  },
  rank: {
    type: String,
    enum: ['None', 'Scout', 'Tracker', 'Ranger', 'Hunter', 'Elite Hunter', 'Master Hunter', 'Legend Hunter'],
    default: 'None',
  },
  isForcedRank: {
    type: Boolean,
    default: false,
    index: true,
  },
  isForcedMembership: {
    type: Boolean,
    default: false,
    index: true,
  },
  isVoucherMembership: {
    type: Boolean,
    default: false,
    index: true,
  },
  teamVolume: {
    type: Number,
    default: 0,
  },
  legVolumes: {
    type: Map,
    of: Number,
    default: {},
  },
  hntrPoints: {
    type: Number,
    default: 0,
  },
  joinedAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model<IUser>('User', UserSchema);
