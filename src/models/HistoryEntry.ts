import mongoose, { Schema, Document } from 'mongoose';

export interface IHistoryEntry extends Document {
  userId: mongoose.Types.ObjectId;
  /** Rutina a la que pertenece este punto de historial (progreso por rutina). */
  routineId?: mongoose.Types.ObjectId;
  date: string; // Formato: 'Ene', 'Feb', etc. (para mostrar)
  week?: number; // Semana 1-52 para ordenar por tramos
  year?: number; // Año para ordenar por tramos
  rms: {
    bench: number;
    squat: number;
    deadlift: number;
    [key: string]: number;
  };
  total: number;
  trainingMaxes: Record<string, number>; // TM ID -> value
  createdAt: Date;
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
    date: {
      type: String,
      required: true,
    },
    week: { type: Number },
    year: { type: Number },
    rms: {
      type: Schema.Types.Mixed,
      required: true,
    },
    total: {
      type: Number,
      required: true,
    },
    trainingMaxes: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

HistoryEntrySchema.index({ userId: 1, date: 1 });
HistoryEntrySchema.index({ userId: 1, year: 1, week: 1 });
HistoryEntrySchema.index({ userId: 1, routineId: 1, year: 1, week: 1 });
HistoryEntrySchema.index({ userId: 1, createdAt: -1 });

export const HistoryEntry = mongoose.model<IHistoryEntry>('HistoryEntry', HistoryEntrySchema);
