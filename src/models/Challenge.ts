import mongoose, { Schema, Document } from 'mongoose';

export interface IChallengeParticipant {
  userId: mongoose.Types.ObjectId;
  name: string;
  avatar: string;
  score: number;
  value: number; // raw value (e.g. reps)
  initialValue?: number; // primera marca al unirse (para calcular progreso)
  initialScore?: number;
  joinedAt?: Date; // fecha de primera participación
}

export type ChallengeType = 'max_reps' | 'weight' | 'seconds';

export interface IChallenge extends Document {
  createdBy: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  type: ChallengeType;
  exercise: string;
  participants: IChallengeParticipant[];
  endDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ChallengeParticipantSchema = new Schema<IChallengeParticipant>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  avatar: {
    type: String,
  },
  score: {
    type: Number,
    required: true,
  },
  value: {
    type: Number,
    required: true,
  },
  initialValue: { type: Number },
  initialScore: { type: Number },
  joinedAt: { type: Date },
}, { _id: false });

const ChallengeSchema = new Schema<IChallenge>(
  {
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    type: {
      type: String,
      enum: ['max_reps', 'weight', 'seconds'],
      required: true,
    },
    exercise: {
      type: String,
      required: true,
    },
    participants: [ChallengeParticipantSchema],
    endDate: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

ChallengeSchema.index({ endDate: 1 });

export const Challenge = mongoose.model<IChallenge>('Challenge', ChallengeSchema);
