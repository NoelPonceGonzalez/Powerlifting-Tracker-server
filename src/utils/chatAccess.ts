import mongoose from 'mongoose';
import { ChatHide } from '../models/ChatHide';
import { ChatMessage } from '../models/ChatMessage';
import { ChatRequest } from '../models/ChatRequest';
import { User } from '../models/User';
import { areFriends, follows } from './friendship';

export async function chatIsOpen(me: string, other: string): Promise<boolean> {
  if (!me || !other || me === other || !mongoose.isValidObjectId(other)) return false;
  if (await areFriends(me, other)) return true;
  if (await follows(me, other)) return true;
  const [iTrain, theyTrain, accepted] = await Promise.all([
    User.exists({ _id: me, coachId: other }),
    User.exists({ _id: other, coachId: me }),
    ChatRequest.exists({
      status: 'accepted',
      $or: [
        { from: me, to: other },
        { from: other, to: me },
      ],
    }),
  ]);
  return !!(iTrain || theyTrain || accepted);
}

export async function ensurePendingChatRequest(fromId: string, toId: string, preview: string) {
  if (!fromId || !toId || fromId === toId) return null;
  const text = (preview || '').trim().slice(0, 2000);
  const existing = await ChatRequest.findOne({ from: fromId, to: toId });
  if (existing) {
    if (existing.status === 'accepted') return existing;
    existing.status = 'pending';
    if (text) existing.preview = text;
    await existing.save();
    return existing;
  }
  return ChatRequest.create({
    from: fromId,
    to: toId,
    status: 'pending',
    preview: text,
  });
}

export async function wipeDmBothSides(a: string, b: string) {
  await Promise.all([
    ChatMessage.deleteMany({
      groupId: null,
      $or: [
        { from: a, to: b },
        { from: b, to: a },
      ],
    }),
    ChatRequest.deleteMany({
      $or: [
        { from: a, to: b },
        { from: b, to: a },
      ],
    }),
    ChatHide.deleteMany({
      kind: 'dm',
      $or: [
        { user: a, targetId: b },
        { user: b, targetId: a },
      ],
    }),
  ]);
}
