import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  email: string;
  username?: string;
  password?: string;
  name?: string;
  gender?: 'hombre' | 'mujer';
  avatar?: string;
  bodyWeight?: number;
  /** Texto libre del perfil público. */
  bio?: string;
  /** Amigo marcado como entrenador: se muestra en su perfil y en el de sus alumnos. */
  coachId?: mongoose.Types.ObjectId | null;
  theme?: 'light' | 'dark';
  /** Acento rosa (MB) en toda la UI; independiente de claro/oscuro. */
  mbMode?: boolean;
  progressMode?: 'month' | 'year';
  emailVerified: boolean;
  resetPasswordToken?: string;
  resetPasswordExpires?: Date;
  /** Tokens Expo por dispositivo (varios móviles/tablets por cuenta). */
  pushTokens?: string[];
  /** Lista única de mejores amigos (historias, gym y torneos). */
  closeFriendIds?: mongoose.Types.ObjectId[];
  /** A quién he bloqueado. */
  blockedUserIds?: mongoose.Types.ObjectId[];
  /** Sube al cerrar otras sesiones; el JWT lleva este número. */
  sessionVersion?: number;
  workoutReminderOn?: boolean;
  /** HH:MM en la zona del usuario. */
  workoutReminderTime?: string;
  timezone?: string;
  /** Día civil (YYYY-MM-DD) del último recordatorio enviado. */
  workoutReminderDate?: string;
  /** Suscripciones Web Push (PWA / Chrome / Safari instalado). */
  webPushSubscriptions?: {
    endpoint: string;
    keys?: { p256dh?: string; auth?: string } | null;
    createdAt?: Date;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    username: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
      trim: true,
      index: true,
      minlength: 3,
      maxlength: 30,
    },
    password: {
      type: String,
      required: false,
    },
    name: {
      type: String,
      trim: true,
    },
    gender: {
      type: String,
      enum: ['hombre', 'mujer'],
    },
    avatar: {
      type: String,
    },
    bodyWeight: {
      type: Number,
    },
    bio: {
      type: String,
      trim: true,
      maxlength: 300,
    },
    coachId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    theme: {
      type: String,
      enum: ['light', 'dark'],
      // Sin default: si no está definido, el cliente usa preferencia del sistema (prefers-color-scheme)
    },
    progressMode: {
      type: String,
      enum: ['month', 'year'],
    },
    mbMode: {
      type: Boolean,
      default: false,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    resetPasswordToken: {
      type: String,
    },
    resetPasswordExpires: {
      type: Date,
    },
    pushTokens: {
      type: [String],
      default: [],
    },
    closeFriendIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    blockedUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    sessionVersion: { type: Number, default: 0 },
    workoutReminderOn: { type: Boolean, default: true },
    workoutReminderTime: { type: String, default: '10:00' },
    timezone: { type: String, default: 'Europe/Madrid' },
    workoutReminderDate: { type: String, default: '' },
    webPushSubscriptions: {
      type: [
        {
          endpoint: { type: String, required: true },
          keys: {
            p256dh: { type: String, required: true },
            auth: { type: String, required: true },
          },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// Índices para mejorar búsquedas
UserSchema.index({ resetPasswordToken: 1 });

export const User = mongoose.model<IUser>('User', UserSchema);
