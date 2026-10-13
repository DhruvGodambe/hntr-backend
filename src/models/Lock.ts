import mongoose, { Schema, Document } from 'mongoose';

/** Cross-process lease lock (see utils/dbLock.ts). One document per lock key. */
export interface ILock extends Document {
  key: string;
  owner: string;
  expiresAt: Date;
}

const LockSchema: Schema = new Schema({
  key: { type: String, required: true, unique: true },
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});

export default mongoose.model<ILock>('Lock', LockSchema);
