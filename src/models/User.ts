import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  email: string;
  username?: string;
  password?: string;
  name?: string;
  gender?: 'hombre' | 'mujer';
  avatar?: string;
  bodyWeight?: number;
  theme?: 'light' | 'dark';
  progressMode?: 'month' | 'year';
  emailVerified: boolean;
  verificationToken?: string;
  verificationTokenExpires?: Date;
  resetPasswordToken?: string;
  resetPasswordExpires?: Date;
  pushToken?: string;
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
    theme: {
      type: String,
      enum: ['light', 'dark'],
      // Sin default: si no está definido, el cliente usa preferencia del sistema (prefers-color-scheme)
    },
    progressMode: {
      type: String,
      enum: ['month', 'year'],
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    verificationToken: {
      type: String,
    },
    verificationTokenExpires: {
      type: Date,
    },
    resetPasswordToken: {
      type: String,
    },
    resetPasswordExpires: {
      type: Date,
    },
    pushToken: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Índices para mejorar búsquedas
UserSchema.index({ verificationToken: 1 });
UserSchema.index({ resetPasswordToken: 1 });

export const User = mongoose.model<IUser>('User', UserSchema);
