import mongoose, { Schema, Document } from 'mongoose';

export interface ISyncState extends Document {
  key: string;
  lastProcessedBlock: number;
  updatedAt: Date;
}

const SyncStateSchema: Schema = new Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  lastProcessedBlock: {
    type: Number,
    required: true,
    default: 0,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model<ISyncState>('SyncState', SyncStateSchema);
