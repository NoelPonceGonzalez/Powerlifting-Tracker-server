import mongoose, { Schema, Document } from 'mongoose';

export interface IWorkoutExercise extends Document {
  sessionId: mongoose.Types.ObjectId;
  templateExerciseId?: mongoose.Types.ObjectId;
  exerciseName: string;
  exerciseIndex: number; // 1-based to match plan IDs (e1, e2…)
  notes: string;
  rpe: string;
  completed: boolean;
  exerciseWeight?: number;
}

const WorkoutExerciseSchema = new Schema<IWorkoutExercise>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'WorkoutSession', required: true, index: true },
    templateExerciseId: { type: Schema.Types.ObjectId, ref: 'TemplateExercise' },
    exerciseName: { type: String, required: true },
    exerciseIndex: { type: Number, required: true, min: 1 },
    notes: { type: String, default: '' },
    rpe: { type: String, default: '' },
    completed: { type: Boolean, default: false },
    exerciseWeight: { type: Number },
  },
  { timestamps: false }
);

WorkoutExerciseSchema.index({ sessionId: 1, exerciseIndex: 1 }, { unique: true });

export const WorkoutExercise = mongoose.model<IWorkoutExercise>('WorkoutExercise', WorkoutExerciseSchema);
