import mongoose, { Schema, Document } from 'mongoose';
import type { BodyWeightScoringMode } from '../utils/challengeScoring';

export interface IChallengeParticipant {
  userId: mongoose.Types.ObjectId;
  name: string;
  avatar: string;
  score: number;
  value: number; // raw value (e.g. reps) o suma si hay varios ejercicios
  lifts?: { exercise: string; value: number }[];
  initialValue?: number; // primera marca al unirse (para calcular progreso)
  initialScore?: number;
  /** Puesto (1 = primero) en el momento de meterse. Sirve para ver si has subido o bajado. */
  initialRank?: number;
  joinedAt?: Date; // fecha de primera participación
}

export type ChallengeType = 'max_reps' | 'weight' | 'seconds';

export interface IChallenge extends Document {
  createdBy: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  type: ChallengeType;
  exercise: string;
  /** Uno o varios (SBD, etc.). `exercise` se guarda como texto unido por compatibilidad. */
  exercises?: string[];
  isPrivate?: boolean;
  /** Solo lo ven (y pueden unirse) los mejores amigos del creador. */
  closeFriendsOnly?: boolean;
  passwordHash?: string;
  /** Si false, el ranking usa la marca bruta (kg / reps / s). Si true, IPF GL (peso) y fórmulas por peso/género (reps/seg). */
  usePointsSystem: boolean;
  /** Ponderación por peso en reps/seg: más peso = más puntos | menos peso = más puntos | sin ponderar. */
  bodyWeightScoring: BodyWeightScoringMode;
  /** Cuándo se enviaron notificaciones de ganador al cerrar el torneo. */
  winnerNotifiedAt?: Date | null;
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
  lifts: {
    type: [
      {
        exercise: { type: String, required: true },
        value: { type: Number, required: true },
        _id: false,
      },
    ],
    default: undefined,
  },
  initialValue: { type: Number },
  initialScore: { type: Number },
  initialRank: { type: Number },
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
    exercises: {
      type: [String],
      default: undefined,
    },
    isPrivate: {
      type: Boolean,
      default: false,
    },
    closeFriendsOnly: {
      type: Boolean,
      default: false,
    },
    passwordHash: {
      type: String,
      default: '',
      select: false,
    },
    usePointsSystem: {
      type: Boolean,
      default: true,
    },
    bodyWeightScoring: {
      type: String,
      enum: ['heavier_more', 'lighter_more', 'neutral'],
      default: 'heavier_more',
    },
    winnerNotifiedAt: {
      type: Date,
      default: null,
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
