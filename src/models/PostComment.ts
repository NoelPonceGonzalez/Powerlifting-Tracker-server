import mongoose, { Schema, Document } from 'mongoose';

export interface IPostComment extends Document {
  postId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  text: string;
  /** Gente mencionada con @ en el texto. */
  mentions?: { userId: mongoose.Types.ObjectId; name: string }[];
  createdAt: Date;
  updatedAt: Date;
}

const PostCommentSchema = new Schema<IPostComment>(
  {
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    mentions: {
      type: [{ _id: false, userId: { type: Schema.Types.ObjectId, ref: 'User' }, name: String }],
      default: [],
    },
  },
  { timestamps: true }
);

PostCommentSchema.index({ postId: 1, createdAt: 1 });

export const PostComment = mongoose.model<IPostComment>('PostComment', PostCommentSchema);
