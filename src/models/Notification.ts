import mongoose, { Schema, Document } from 'mongoose';

export type NotificationType = 'gym_checkin' | 'friend_request' | 'challenge_invite' | 'friend_accepted';

export interface INotification extends Document {
  userId: mongoose.Types.ObjectId; // Usuario que recibe la notificación
  type: NotificationType;
  title: string;
  message: string;
  relatedUserId?: mongoose.Types.ObjectId; // Usuario relacionado (ej: quien hizo check-in)
  relatedData?: Record<string, any>; // Datos adicionales
  read: boolean;
  createdAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['gym_checkin', 'friend_request', 'challenge_invite', 'friend_accepted'],
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    relatedUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    relatedData: {
      type: Schema.Types.Mixed,
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

NotificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, createdAt: -1 });

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema);
