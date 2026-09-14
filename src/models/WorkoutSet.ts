import mongoose, { Schema, Document } from 'mongoose';

export interface IWorkoutSet extends Document {
  workoutExerciseId: mongoose.Types.ObjectId;
  setIndex: number; // 0-based
  reps?: number;
  weight?: number;
  completed: boolean;
  rpe: string;
  inputMode?: 'kg' | 'pct';
  mediaKey?: string | null;
  mediaType?: 'image' | 'video' | null;
}

const WorkoutSetSchema = new Schema<IWorkoutSet>(
  {
    workoutExerciseId: { type: Schema.Types.ObjectId, ref: 'WorkoutExercise', required: true, index: true },
    setIndex: { type: Number, required: true, min: 0 },
    reps: { type: Number },
    weight: { type: Number },
    completed: { type: Boolean, default: false },
    rpe: { type: String, default: '' },
    inputMode: { type: String, enum: ['kg', 'pct'] },
    mediaKey: { type: String, default: null },
    mediaType: { type: String, enum: ['image', 'video'], default: null },
  },
  { timestamps: false }
);

WorkoutSetSchema.index({ workoutExerciseId: 1, setIndex: 1 }, { unique: true });

export const WorkoutSet = mongoose.model<IWorkoutSet>('WorkoutSet', WorkoutSetSchema);
