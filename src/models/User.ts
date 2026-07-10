import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  username: string;
  walletAddress: string;
  email?: string;
  phone?: string;
  sponsorUsername?: string | null;
  ancestors: string[];
  directDownline: string[];
  tier: 'None' | 'Scout' | 'Tracker' | 'Ranger' | 'Hunter' | 'Apex';
  rank: 'None' | 'Tracker' | 'Ranger' | 'Hunter' | 'Apex' | 'Elite' | 'Master' | 'Legend';
  teamVolume: number;
  legVolumes: Map<string, number>;
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
    enum: ['None', 'Scout', 'Tracker', 'Ranger', 'Hunter', 'Apex'],
    default: 'None',
  },
  rank: {
    type: String,
    enum: ['None', 'Tracker', 'Ranger', 'Hunter', 'Apex', 'Elite', 'Master', 'Legend'],
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
  joinedAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model<IUser>('User', UserSchema);
