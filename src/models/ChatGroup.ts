import mongoose, { Schema, Document } from 'mongoose';

export interface IChatGroup extends Document {
  name: string;
  createdBy: mongoose.Types.ObjectId;
  members: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const ChatGroupSchema = new Schema<IChatGroup>(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    members: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
  },
  { timestamps: true }
);

ChatGroupSchema.index({ members: 1 });

export const ChatGroup = mongoose.model<IChatGroup>('ChatGroup', ChatGroupSchema);
