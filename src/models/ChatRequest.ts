import mongoose, { Schema, Document } from 'mongoose';

export interface IChatRequest extends Document {
  from: mongoose.Types.ObjectId;
  to: mongoose.Types.ObjectId;
  status: 'pending' | 'accepted' | 'rejected';
  preview?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ChatRequestSchema = new Schema<IChatRequest>(
  {
    from: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    to: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending', index: true },
    preview: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

ChatRequestSchema.index({ from: 1, to: 1 }, { unique: true });
ChatRequestSchema.index({ to: 1, status: 1 });

export const ChatRequest = mongoose.model<IChatRequest>('ChatRequest', ChatRequestSchema);
