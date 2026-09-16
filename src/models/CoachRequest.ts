import mongoose, { Schema, Document } from 'mongoose';

/**
 * Petición de «sé mi entrenador»: la manda el alumno y solo cuenta cuando el entrenador
 * la acepta. Al aceptarla se escribe `coachId` en el alumno.
 */
export interface ICoachRequest extends Document {
  athlete: mongoose.Types.ObjectId;
  coach: mongoose.Types.ObjectId;
  /** Quién empezó: el alumno pide «entréneme»; el entrenador invita «te entreno». */
  initiatedBy: 'athlete' | 'coach';
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: Date;
  updatedAt: Date;
}

const CoachRequestSchema = new Schema<ICoachRequest>(
  {
    athlete: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    coach: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    initiatedBy: { type: String, enum: ['athlete', 'coach'], default: 'athlete' },
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending', index: true },
  },
  { timestamps: true }
);

CoachRequestSchema.index({ athlete: 1, coach: 1 }, { unique: true });

export const CoachRequest = mongoose.model<ICoachRequest>('CoachRequest', CoachRequestSchema);
