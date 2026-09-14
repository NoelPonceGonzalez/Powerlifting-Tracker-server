import mongoose, { Schema, Document } from 'mongoose';

export interface IChatMessage extends Document {
  from: mongoose.Types.ObjectId;
  /** Chat 1 a 1. Vacío si el mensaje es de un grupo. */
  to?: mongoose.Types.ObjectId | null;
  groupId?: mongoose.Types.ObjectId | null;
  text: string;
  mediaKey?: string | null;
  mediaType?: 'image' | 'video' | null;
  readAt?: Date | null;
  /** En grupos: quién ya lo ha abierto. */
  readBy?: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const ChatMessageSchema = new Schema<IChatMessage>(
  {
    from: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    to: { type: Schema.Types.ObjectId, ref: 'User', required: false, default: null, index: true },
    groupId: { type: Schema.Types.ObjectId, ref: 'ChatGroup', required: false, default: null, index: true },
    text: { type: String, required: false, default: '', trim: true, maxlength: 2000 },
    mediaKey: { type: String, default: null },
    mediaType: { type: String, enum: ['image', 'video'], default: null },
    readAt: { type: Date, default: null },
    readBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

ChatMessageSchema.index({ from: 1, to: 1, createdAt: -1 });
ChatMessageSchema.index({ to: 1, readAt: 1 });
ChatMessageSchema.index({ groupId: 1, createdAt: -1 });

export const ChatMessage = mongoose.model<IChatMessage>('ChatMessage', ChatMessageSchema);
