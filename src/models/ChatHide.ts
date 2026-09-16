import mongoose, { Schema, Document } from 'mongoose';

/** Chat oculto para un usuario: no sale en su bandeja ni ve mensajes anteriores. */
export interface IChatHide extends Document {
  user: mongoose.Types.ObjectId;
  kind: 'dm' | 'group';
  targetId: mongoose.Types.ObjectId;
  hiddenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ChatHideSchema = new Schema<IChatHide>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['dm', 'group'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    hiddenAt: { type: Date, required: true },
  },
  { timestamps: true }
);

ChatHideSchema.index({ user: 1, kind: 1, targetId: 1 }, { unique: true });

export const ChatHide = mongoose.model<IChatHide>('ChatHide', ChatHideSchema);
