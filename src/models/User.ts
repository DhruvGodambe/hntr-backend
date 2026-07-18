import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  username: string;
  walletAddress: string;
  email?: string;
  phone?: string;
  sponsorUsername?: string | null;
  ancestors: string[];
  directDownline: string[];
  tier: 'None' | 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond';
  rank: 'None' | 'Scout' | 'Tracker' | 'Ranger' | 'Hunter' | 'Elite Hunter' | 'Master Hunter' | 'Legend Hunter';
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
    required: true,
    unique: true,
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
