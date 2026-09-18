import mongoose from 'mongoose';
import { User } from '../models/User';
import { Friendship } from '../models/Friendship';
import { Notification } from '../models/Notification';
import { ChatMessage } from '../models/ChatMessage';
import { Post } from '../models/Post';
import { Routine } from '../models/Routine';
import { TrainingMax } from '../models/TrainingMax';
import { HistoryEntry } from '../models/HistoryEntry';
import { logger } from './logger';

/**
 * Un email = una cuenta. Borra huérfanos sin contraseña y fusiona
 * cuentas completadas duplicadas (mismo email) en la más reciente.
 */
export async function dedupeUsersByEmail(): Promise<void> {
  const groups = await User.aggregate<{ _id: string; ids: mongoose.Types.ObjectId[]; count: number }>([
    { $project: { email: { $toLower: { $ifNull: ['$email', ''] } }, password: 1 } },
    { $match: { email: { $ne: '' } } },
    { $group: { _id: '$email', ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  let removed = 0;
  for (const g of groups) {
    const users = await User.find({ _id: { $in: g.ids } }).select(
      'password updatedAt createdAt pushTokens webPushSubscriptions'
    );
    const completed = users.filter(u => !!u.password);
    const incomplete = users.filter(u => !u.password);

    if (incomplete.length) {
      await User.deleteMany({ _id: { $in: incomplete.map(u => u._id) } });
      removed += incomplete.length;
    }

    if (completed.length <= 1) continue;

    completed.sort((a, b) => {
      const ta = +(b.updatedAt || b.createdAt || 0) - +(a.updatedAt || a.createdAt || 0);
      return ta;
    });
    const keep = completed[0];
    const drop = completed.slice(1);
    const tokens = [...new Set([...(keep.pushTokens || []), ...drop.flatMap(u => u.pushTokens || [])])];
    const subs = [...(keep.webPushSubscriptions || [])];
    for (const d of drop) {
      for (const s of d.webPushSubscriptions || []) {
        if (s?.endpoint && !subs.some(x => x.endpoint === s.endpoint)) subs.push(s);
      }
    }
    await User.updateOne(
      { _id: keep._id },
      { $set: { pushTokens: tokens, webPushSubscriptions: subs.slice(-8) } }
    );

    for (const d of drop) {
      await remapUserRefs(String(d._id), String(keep._id));
      await User.deleteOne({ _id: d._id });
      removed += 1;
    }
  }

  if (removed > 0) {
    logger.info(`[dedupe] Cuentas duplicadas por email eliminadas: ${removed}`);
  }

  try {
    await User.collection.createIndex({ email: 1 }, { unique: true, background: true });
  } catch (err) {
    logger.warn('[dedupe] No se pudo asegurar el índice único de email', err);
  }
}

async function remapUserRefs(fromId: string, toId: string): Promise<void> {
  const from = new mongoose.Types.ObjectId(fromId);
  const to = new mongoose.Types.ObjectId(toId);

  const keepPairs = await Friendship.find({
    $or: [{ requester: to }, { recipient: to }],
  })
    .select('requester recipient')
    .lean();
  const keepKeys = new Set(keepPairs.map(f => `${f.requester}-${f.recipient}`));

  const dropFriends = await Friendship.find({
    $or: [{ requester: from }, { recipient: from }],
  });
  for (const f of dropFriends) {
    const newReq = String(f.requester) === fromId ? to : f.requester;
    const newRec = String(f.recipient) === fromId ? to : f.recipient;
    if (String(newReq) === String(newRec) || keepKeys.has(`${newReq}-${newRec}`)) {
      await f.deleteOne();
      continue;
    }
    f.requester = newReq;
    f.recipient = newRec;
    try {
      await f.save();
    } catch {
      await f.deleteOne();
    }
  }

  await Promise.all([
    Notification.updateMany({ userId: from }, { $set: { userId: to } }),
    Notification.updateMany({ relatedUserId: from }, { $set: { relatedUserId: to } }),
    ChatMessage.updateMany({ from }, { $set: { from: to } }),
    ChatMessage.updateMany({ to: from }, { $set: { to } }),
    Post.updateMany({ userId: from }, { $set: { userId: to } }),
    Routine.updateMany({ userId: from }, { $set: { userId: to } }),
    TrainingMax.updateMany({ userId: from }, { $set: { userId: to } }),
    HistoryEntry.updateMany({ userId: from }, { $set: { userId: to } }),
  ]);
}
