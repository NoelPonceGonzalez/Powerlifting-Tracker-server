import mongoose, { Schema, Document } from 'mongoose';

export interface ITrainingMax extends Document {
  userId: mongoose.Types.ObjectId;
  /** Rutina a la que pertenecen estos TM (cada rutina tiene su propio juego). */
  routineId: mongoose.Types.ObjectId;
  name: string;
  value: number;
  mode: 'weight' | 'reps' | 'seconds';
  linkedExercise?: string; // 'bench' | 'squat' | 'deadlift'
  sharedToSocial?: boolean; // true = visible en perfil para amigos
  createdAt: Date;
  updatedAt: Date;
}

const TrainingMaxSchema = new Schema<ITrainingMax>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    value: {
      type: Number,
      required: true,
    },
    mode: {
      type: String,
      enum: ['weight', 'reps', 'seconds'],
      required: true,
    },
    linkedExercise: {
      type: String,
      enum: ['bench', 'squat', 'deadlift'],
    },
    sharedToSocial: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

TrainingMaxSchema.index({ userId: 1, routineId: 1 });
TrainingMaxSchema.index({ userId: 1, linkedExercise: 1 });

export const TrainingMax = mongoose.model<ITrainingMax>('TrainingMax', TrainingMaxSchema);
