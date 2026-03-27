import mongoose, { Schema, Document } from 'mongoose';

export interface IWorkoutSession extends Document {
  userId: mongoose.Types.ObjectId;
  routineId: mongoose.Types.ObjectId;
  programVersionId?: mongoose.Types.ObjectId;
  dateISO: string; // YYYY-MM-DD civil anchor
  planWeek: number; // 1-52
  planDayIndex: number; // 0-based
  createdAt: Date;
  updatedAt: Date;
}

const WorkoutSessionSchema = new Schema<IWorkoutSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    routineId: { type: Schema.Types.ObjectId, ref: 'Routine', required: true, index: true },
    programVersionId: { type: Schema.Types.ObjectId, ref: 'ProgramVersion' },
    dateISO: { type: String, required: true },
    planWeek: { type: Number, required: true, min: 1, max: 52 },
    planDayIndex: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

WorkoutSessionSchema.index({ routineId: 1, planWeek: 1, planDayIndex: 1 }, { unique: true });
WorkoutSessionSchema.index({ userId: 1, dateISO: 1 });
WorkoutSessionSchema.index({ routineId: 1, dateISO: 1 });

export const WorkoutSession = mongoose.model<IWorkoutSession>('WorkoutSession', WorkoutSessionSchema);
