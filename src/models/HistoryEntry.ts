import mongoose, { Schema, Document } from 'mongoose';

/**
 * HistoryEntry: punto de progreso con fecha civil.
 * TM snapshots → colección HistoryTmSnapshot (sin JSON).
 * RM bench/squat/deadlift como columnas.
 */
export interface IHistoryEntry extends Document {
  userId: mongoose.Types.ObjectId;
  routineId?: mongoose.Types.ObjectId;
  dateISO: string;
  dateLabel: string;
  year: number;
  month: number;
  planWeek?: number;
  dayOfWeek?: number;
  total: number;
  progressKind?: 'weight' | 'reps' | 'seconds' | 'mixed';
  benchRm?: number;
  squatRm?: number;
  deadliftRm?: number;
  /** @deprecated migrar a HistoryTmSnapshot */
  trainingMaxes?: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

const HistoryEntrySchema = new Schema<IHistoryEntry>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    routineId: {
      type: Schema.Types.ObjectId,
      ref: 'Routine',
      index: true,
    },
    dateISO: { type: String, required: true },
    dateLabel: { type: String, default: '' },
    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    planWeek: { type: Number },
    dayOfWeek: { type: Number, min: 0, max: 6 },
    total: { type: Number, required: true, default: 0 },
    progressKind: { type: String, enum: ['weight', 'reps', 'seconds', 'mixed'] },
    benchRm: { type: Number },
    squatRm: { type: Number },
    deadliftRm: { type: Number },
    trainingMaxes: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

HistoryEntrySchema.index({ userId: 1, routineId: 1, dateISO: 1 });
HistoryEntrySchema.index({ userId: 1, routineId: 1, year: 1, month: 1 });
HistoryEntrySchema.index({ userId: 1, routineId: 1, year: 1, planWeek: 1, dayOfWeek: 1 });
HistoryEntrySchema.index({ userId: 1, createdAt: -1 });

export const HistoryEntry = mongoose.model<IHistoryEntry>('HistoryEntry', HistoryEntrySchema);
