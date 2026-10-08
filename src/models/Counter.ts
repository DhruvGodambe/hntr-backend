import mongoose, { Schema, Document } from 'mongoose';

/** Generic atomic sequence counter (e.g. Priority Line numbers). */
export interface ICounter extends Document {
  key: string;
  seq: number;
}

const CounterSchema: Schema = new Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, required: true, default: 0 },
});

export default mongoose.model<ICounter>('Counter', CounterSchema);
