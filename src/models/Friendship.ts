import mongoose, { Schema, Document } from 'mongoose';

export interface IFriendship extends Document {
  requester: mongoose.Types.ObjectId; // Usuario que envía la solicitud
  recipient: mongoose.Types.ObjectId; // Usuario que recibe la solicitud
  status: 'pending' | 'accepted' | 'rejected';
  /** Aceptar un follow no os hace amigos: hace falta la solicitud en el otro sentido. */
  followOnly?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const FriendshipSchema = new Schema<IFriendship>(
  {
    requester: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    recipient: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected'],
      default: 'pending',
      index: true,
    },
    followOnly: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

// Índice compuesto único para evitar duplicados
FriendshipSchema.index({ requester: 1, recipient: 1 }, { unique: true });
FriendshipSchema.index({ recipient: 1, status: 1 });
FriendshipSchema.index({ requester: 1, status: 1 });

export const Friendship = mongoose.model<IFriendship>('Friendship', FriendshipSchema);
