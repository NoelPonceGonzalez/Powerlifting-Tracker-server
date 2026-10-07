import mongoose from 'mongoose';
import { User } from '../models/User';
import { connectionSets } from './friendship';
import { blockedIdsFor } from './privacy';

export const MAX_MENTIONS = 20;

export type MentionSnap = { userId: mongoose.Types.ObjectId; name: string };

/** Acepta array, JSON (`'["a","b"]'`) o lista separada por comas: los formularios con archivo mandan texto. */
export function parseMentionIds(raw: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim();
    try {
      const parsed = s.startsWith('[') ? JSON.parse(s) : null;
      list = Array.isArray(parsed) ? parsed : s.replace(/[[\]"'\s]/g, '').split(',');
    } catch {
      list = s.replace(/[[\]"'\s]/g, '').split(',');
    }
  }
  const ids = list.map(v => String(v ?? '').trim()).filter(id => mongoose.isValidObjectId(id));
  return [...new Set(ids)].slice(0, MAX_MENTIONS);
}

/** Gente a la que puedes etiquetar: a quien sigues o te sigue, sin bloqueos. */
export async function taggableIds(userId: string): Promise<Set<string>> {
  const [{ following, followers }, blocked] = await Promise.all([connectionSets(userId), blockedIdsFor(userId)]);
  const out = new Set<string>();
  for (const id of [...following, ...followers]) if (!blocked.has(id)) out.add(id);
  return out;
}

/** Instantánea `{ userId, name }` en el orden pedido, solo de los ids permitidos. */
export async function snapshotMentions(ids: string[], allowed: Set<string>, selfId: string): Promise<MentionSnap[]> {
  const keep = ids.filter(id => id !== selfId && allowed.has(id));
  if (keep.length === 0) return [];
  const users = await User.find({ _id: { $in: keep } }).select('name').lean();
  const byId = new Map(users.map(u => [String(u._id), u]));
  return keep
    .filter(id => byId.has(id))
    .map(id => ({ userId: new mongoose.Types.ObjectId(id), name: byId.get(id)?.name || 'Atleta' }));
}

export function serializeMentions(list: unknown): { id: string; name: string }[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((m: any) => ({ id: String(m?.userId ?? ''), name: String(m?.name || 'Atleta') }))
    .filter(m => m.id);
}
