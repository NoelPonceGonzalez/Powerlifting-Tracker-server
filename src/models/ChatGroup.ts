import mongoose, { Schema, Document } from 'mongoose';

export interface IChatGroup extends Document {
  name: string;
  createdBy: mongoose.Types.ObjectId;
  members: mongoose.Types.ObjectId[];
  /** Equipo de gym vs chat suelto. La invitación y el chat son los mismos. */
  kind: 'group' | 'team';
  createdAt: Date;
  updatedAt: Date;
}

const ChatGroupSchema = new Schema<IChatGroup>(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    members: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
    kind: { type: String, enum: ['group', 'team'], default: 'group' },
  },
  { timestamps: true }
);

ChatGroupSchema.index({ members: 1 });

export const ChatGroup = mongoose.model<IChatGroup>('ChatGroup', ChatGroupSchema);
