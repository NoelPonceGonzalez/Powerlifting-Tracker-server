import mongoose from 'mongoose';
import { Friendship } from '../models/Friendship';

type FriendDoc = {
  requester: unknown;
  recipient: unknown;
  status?: string;
  followOnly?: boolean;
};

export type RelationStatus = 'accepted' | 'pending' | 'rejected' | 'follower' | 'following' | 'none';
export type RelationDirection = 'incoming' | 'outgoing' | null;

function idOf(v: unknown): string {
  return String((v as { toString?: () => string })?.toString?.() ?? v ?? '');
}

export async function loadPair(a: string, b: string) {
  const [mine, theirs] = await Promise.all([
    Friendship.findOne({ requester: a, recipient: b }).lean<FriendDoc | null>(),
    Friendship.findOne({ requester: b, recipient: a }).lean<FriendDoc | null>(),
  ]);
  return { mine, theirs };
}

/** `follower` tiene un follow aceptado hacia `target`. Un documento, una dirección. */
export async function follows(follower: string, target: string): Promise<boolean> {
  if (String(follower) === String(target)) return false;
  const { mine } = await loadPair(String(follower), String(target));
  return mine?.status === 'accepted';
}

/** Amigos: las dos direcciones están aceptadas. Que él me siga no hace que yo le siga. */
export async function areFriends(a: string, b: string): Promise<boolean> {
  if (String(a) === String(b)) return true;
  const { mine, theirs } = await loadPair(String(a), String(b));
  return mine?.status === 'accepted' && theirs?.status === 'accepted';
}

export function describeRelation(
  mine: FriendDoc | null | undefined,
  theirs: FriendDoc | null | undefined
): { status: RelationStatus; direction: RelationDirection; canSend: boolean } {
  const mineOk = mine?.status === 'accepted';
  const theirsOk = theirs?.status === 'accepted';
  if (mineOk && theirsOk) return { status: 'accepted', direction: null, canSend: false };
  if (mine?.status === 'pending') return { status: 'pending', direction: 'outgoing', canSend: false };
  if (theirs?.status === 'pending') return { status: 'pending', direction: 'incoming', canSend: false };
  if (theirsOk && !mineOk) return { status: 'follower', direction: 'incoming', canSend: true };
  if (mineOk && !theirsOk) return { status: 'following', direction: 'outgoing', canSend: false };
  if (mine?.status === 'rejected' || theirs?.status === 'rejected') {
    return { status: 'rejected', direction: mine?.status === 'rejected' ? 'outgoing' : 'incoming', canSend: true };
  }
  return { status: 'none', direction: null, canSend: true };
}

/** El viewer puede ver historias, posts y marcas del autor si le sigue (o es él). */
export async function canSeeContent(viewer: string, author: string): Promise<boolean> {
  if (String(viewer) === String(author)) return true;
  return follows(String(viewer), String(author));
}

/** Ids de amigos mutuos (el otro usuario). */
export async function mutualFriendIds(userId: string): Promise<string[]> {
  const me = String(userId);
  const rows = await Friendship.find({
    status: 'accepted',
    $or: [{ requester: me }, { recipient: me }],
  })
    .select('requester recipient followOnly')
    .lean<FriendDoc[]>();

  const incoming = new Set<string>();
  const outgoing = new Set<string>();

  for (const f of rows) {
    const reqId = idOf(f.requester);
    const recId = idOf(f.recipient);
    const other = reqId === me ? recId : recId === me ? reqId : '';
    if (!other || other === me) continue;
    if (reqId === me) outgoing.add(other);
    else incoming.add(other);
  }

  const friends = new Set<string>();
  for (const other of outgoing) {
    if (incoming.has(other)) friends.add(other);
  }
  return Array.from(friends);
}

/** Autores cuyo contenido veo: yo y a quienes sigo. Quien solo me sigue no entra. */
export async function circleIds(userId: string): Promise<mongoose.Types.ObjectId[]> {
  const { following } = await connectionSets(userId);
  const ids = new Set<string>([String(userId), ...following]);
  return Array.from(ids).map(id => new mongoose.Types.ObjectId(id));
}

/** Quién me sigue: ellos sí pueden ver lo mío. */
export async function followerIds(userId: string): Promise<string[]> {
  const { followers } = await connectionSets(userId);
  return Array.from(followers);
}

export type ConnectionKind = 'mutual' | 'following' | 'follower';

export async function connectionSets(userId: string): Promise<{
  following: Set<string>;
  followers: Set<string>;
  mutual: Set<string>;
  pendingOutgoing: Set<string>;
}> {
  const me = String(userId);
  const rows = await Friendship.find({
    status: { $in: ['accepted', 'pending'] },
    $or: [{ requester: me }, { recipient: me }],
  })
    .select('requester recipient followOnly status')
    .lean<FriendDoc[]>();

  const following = new Set<string>();
  const followers = new Set<string>();
  const pendingOutgoing = new Set<string>();

  for (const f of rows) {
    const reqId = idOf(f.requester);
    const recId = idOf(f.recipient);
    const other = reqId === me ? recId : recId === me ? reqId : '';
    if (!other || other === me) continue;
    if (f.status === 'pending') {
      if (reqId === me) pendingOutgoing.add(other);
      continue;
    }
    if (f.status !== 'accepted') continue;
    if (reqId === me) following.add(other);
    else followers.add(other);
  }

  const mutual = new Set<string>();
  for (const id of following) {
    if (followers.has(id)) mutual.add(id);
  }
  return { following, followers, mutual, pendingOutgoing };
}
