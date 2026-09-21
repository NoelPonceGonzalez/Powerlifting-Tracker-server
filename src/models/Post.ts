import mongoose, { Schema, Document } from 'mongoose';

export type PostKind = 'post' | 'story';
export type PostMedia = 'image' | 'video';

export interface IPost extends Document {
  userId: mongoose.Types.ObjectId;
  kind: PostKind;
  mediaType: PostMedia;
  /** Clave en el almacén de medios (disco o S3): el archivo nunca se guarda en Mongo. */
  mediaKey: string;
  mimeType: string;
  caption?: string;
  likes: mongoose.Types.ObjectId[];
  /** Quién ha visto la historia; solo lo ve su autor. */
  views: mongoose.Types.ObjectId[];
  commentCount: number;
  /** all = quien te sigue; close = solo mejores amigos. */
  audience?: 'all' | 'close';
  /** Solo historias: Mongo las borra sola a las 24 h. */
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PostSchema = new Schema<IPost>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['post', 'story'], default: 'post', index: true },
    mediaType: { type: String, enum: ['image', 'video'], required: true },
    mediaKey: { type: String, required: true },
    mimeType: { type: String, required: true },
    caption: { type: String, trim: true, maxlength: 2200 },
    likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    views: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    commentCount: { type: Number, default: 0 },
    audience: { type: String, enum: ['all', 'close'], default: 'all' },
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

PostSchema.index({ kind: 1, createdAt: -1 });
PostSchema.index({ userId: 1, createdAt: -1 });
/**
 * TTL de seguridad con margen: la barrida de `storyCleanup` borra antes el archivo del
 * almacén y luego el documento. Si algo fallara, Mongo se lleva el documento igualmente.
 */
PostSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

export const Post = mongoose.model<IPost>('Post', PostSchema);
