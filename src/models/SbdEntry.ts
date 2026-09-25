import mongoose, { Schema, Document } from 'mongoose';

export interface ISbdEntry extends Document {
  userId: mongoose.Types.ObjectId;
  squat: number;
  bench: number;
  deadlift: number;
}

const SbdEntrySchema = new Schema<ISbdEntry>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    squat: { type: Number, required: true, min: 0 },
    bench: { type: Number, required: true, min: 0 },
    deadlift: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

export const SbdEntry = mongoose.model<ISbdEntry>('SbdEntry', SbdEntrySchema);
