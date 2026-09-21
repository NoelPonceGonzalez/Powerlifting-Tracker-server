import mongoose from 'mongoose';
import { Friendship } from '../models/Friendship';
import { User } from '../models/User';

function idStr(v: unknown) {
  return String((v as { toString?: () => string })?.toString?.() ?? v ?? '');
}

export async function loadPrivacy(userId: string) {
  const me = await User.findById(userId).select('closeFriendIds blockedUserIds').lean();
  return {
    close: new Set((me?.closeFriendIds || []).map(idStr)),
    blocked: new Set((me?.blockedUserIds || []).map(idStr)),
  };
}

/** Alguno de los dos ha bloqueado al otro. */
export async function blockBetween(a: string, b: string): Promise<'none' | 'you' | 'them'> {
  if (!a || !b || a === b) return 'none';
  const [you, them] = await Promise.all([
    User.findById(a).select('blockedUserIds').lean(),
    User.findById(b).select('blockedUserIds').lean(),
  ]);
  if ((you?.blockedUserIds || []).some(id => idStr(id) === b)) return 'you';
  if ((them?.blockedUserIds || []).some(id => idStr(id) === a)) return 'them';
  return 'none';
}

export async function blockedIdsFor(userId: string): Promise<Set<string>> {
  const me = await User.findById(userId).select('blockedUserIds').lean();
  const mine = new Set((me?.blockedUserIds || []).map(idStr));
  const incoming = await User.find({ blockedUserIds: userId }).select('_id').lean();
  for (const u of incoming) mine.add(idStr(u._id));
  return mine;
}

export function canSeeCloseAudience(viewerId: string, authorId: string, audience: string | undefined, authorClose: Set<string>) {
  if (audience !== 'close') return true;
  if (viewerId === authorId) return true;
  return authorClose.has(viewerId);
}

export async function audienceRecipients(
  authorId: string,
  audience: 'all' | 'close',
  candidateIds: string[]
): Promise<string[]> {
  const unique = [...new Set(candidateIds.filter(id => id && id !== authorId))];
  if (audience !== 'close') return unique;
  const { close } = await loadPrivacy(authorId);
  return unique.filter(id => close.has(id));
}

export async function applyBlock(me: string, target: string) {
  if (me === target) throw new Error('No puedes bloquearte a ti');
  const other = new mongoose.Types.ObjectId(target);
  await User.updateOne({ _id: me }, { $addToSet: { blockedUserIds: other }, $pull: { closeFriendIds: other } });
  await User.updateOne({ _id: target }, { $pull: { closeFriendIds: new mongoose.Types.ObjectId(me) } });
  await Friendship.deleteMany({
    $or: [
      { requester: me, recipient: target },
      { requester: target, recipient: me },
    ],
  });
}
