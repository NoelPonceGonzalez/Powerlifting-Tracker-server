import mongoose, { Schema, Document } from 'mongoose';

/**
 * Registro pendiente: el usuario **no** existe en `User` hasta completar nombre, género, peso y contraseña.
 * Solo email + código de verificación mientras tanto.
 */
export interface IPendingSignup extends Document {
  email: string;
  verificationToken: string;
  verificationTokenExpires: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PendingSignupSchema = new Schema<IPendingSignup>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    verificationToken: {
      type: String,
      required: true,
      index: true,
    },
    verificationTokenExpires: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

PendingSignupSchema.index({ verificationToken: 1, verificationTokenExpires: 1 });

export const PendingSignup = mongoose.model<IPendingSignup>('PendingSignup', PendingSignupSchema);
