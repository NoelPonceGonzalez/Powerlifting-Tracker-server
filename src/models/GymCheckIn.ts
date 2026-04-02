import mongoose, { Schema, Document } from 'mongoose';
import { computeCheckInExpiresAt } from '../utils/checkInExpires';

export interface IGymCheckIn extends Document {
  userId: mongoose.Types.ObjectId;
  userName: string;
  gymName: string;
  time: string; // Formato: '18:00'
  timestamp: Date;
  /** Borrado automático por TTL: hora de entreno + 3 h (mismo día que timestamp). */
  expiresAt: Date;
  createdAt: Date;
}

const GymCheckInSchema = new Schema<IGymCheckIn>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    userName: {
      type: String,
      required: true,
    },
    gymName: {
      type: String,
      required: true,
    },
    time: {
      type: String,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    expiresAt: {
      type: Date,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

GymCheckInSchema.index({ userId: 1, timestamp: -1 });
/** TTL: se elimina el documento cuando expiresAt < ahora (tras ~1 min de márgen del monitor). */
GymCheckInSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

GymCheckInSchema.pre('save', function (next) {
  if (this.time && this.timestamp) {
    this.expiresAt = computeCheckInExpiresAt(this.timestamp, this.time);
  }
  next();
});

export const GymCheckIn = mongoose.model<IGymCheckIn>('GymCheckIn', GymCheckInSchema);
