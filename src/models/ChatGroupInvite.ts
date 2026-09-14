import mongoose, { Schema, Document } from 'mongoose';

export interface IChatGroupInvite extends Document {
  groupId: mongoose.Types.ObjectId;
  from: mongoose.Types.ObjectId;
  to: mongoose.Types.ObjectId;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: Date;
  updatedAt: Date;
}

const ChatGroupInviteSchema = new Schema<IChatGroupInvite>(
  {
    groupId: { type: Schema.Types.ObjectId, ref: 'ChatGroup', required: true, index: true },
    from: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    to: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending', index: true },
  },
  { timestamps: true }
);

ChatGroupInviteSchema.index({ groupId: 1, to: 1 }, { unique: true });
ChatGroupInviteSchema.index({ to: 1, status: 1 });

export const ChatGroupInvite = mongoose.model<IChatGroupInvite>('ChatGroupInvite', ChatGroupInviteSchema);
