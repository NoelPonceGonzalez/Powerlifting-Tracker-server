import mongoose, { Schema, Document } from 'mongoose';

export interface IGymCheckIn extends Document {
  userId: mongoose.Types.ObjectId;
  userName: string;
  gymName: string;
  time: string; // Formato: '18:00'
  timestamp: Date;
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
  },
  {
    timestamps: true,
  }
);

GymCheckInSchema.index({ userId: 1, timestamp: -1 });
GymCheckInSchema.index({ timestamp: -1 });

export const GymCheckIn = mongoose.model<IGymCheckIn>('GymCheckIn', GymCheckInSchema);
