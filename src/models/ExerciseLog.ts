import mongoose, { Schema, Document } from 'mongoose';

/** Una fila por ejercicio logueado (clave estable: routineId + logKey). */
export interface IExerciseLog extends Document {
  routineId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  logKey: string;
  rpe: string;
  notes: string;
  completed: boolean;
  weight?: number;
  sets?: Array<{
    id: string;
    reps: number | null;
    weight: number | null;
    completed: boolean;
    inputMode?: 'kg' | 'pct';
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const SetLogSchema = new Schema(
  {
    id: { type: String, required: true },
    reps: { type: Schema.Types.Mixed, default: null },
    weight: { type: Schema.Types.Mixed, default: null },
    completed: { type: Boolean, default: false },
    inputMode: { type: String, enum: ['kg', 'pct'] },
  },
  { _id: false }
);

const ExerciseLogSchema = new Schema<IExerciseLog>(
  {
    routineId: { type: Schema.Types.ObjectId, ref: 'Routine', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    logKey: { type: String, required: true, trim: true },
    rpe: { type: String, default: '' },
    notes: { type: String, default: '' },
    completed: { type: Boolean, default: false },
    weight: { type: Number },
    sets: [SetLogSchema],
  },
  { timestamps: true }
);

ExerciseLogSchema.index({ routineId: 1, logKey: 1 }, { unique: true });
ExerciseLogSchema.index({ userId: 1, routineId: 1 });

export const ExerciseLog = mongoose.model<IExerciseLog>('ExerciseLog', ExerciseLogSchema);
