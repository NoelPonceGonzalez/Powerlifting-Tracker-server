import { User } from '../models/User';
import { logger } from './logger';
import { isSupportedMediaType, mediaStorage } from './mediaStorage';

const DATA_RE = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([a-z0-9+/=\s]+)$/i;
const KEY_RE =
  /^\d{6}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;
const MAX_BYTES = 6 * 1024 * 1024;

export function isInlineAvatar(value?: string | null): boolean {
  return !!value && value.startsWith('data:image/');
}

export function isAvatarMediaKey(value?: string | null): boolean {
  return !!value && KEY_RE.test(value.trim());
}

const FAKE_AVATAR = /picsum\.photos|ui-avatars\.com|pravatar\.cc|randomuser\.me/i;

/** Lo que se manda al cliente: clave o URL, nunca un data: enorme. */
export function publicAvatarRef(value?: string | null): string {
  const raw = (value || '').trim();
  if (!raw || isInlineAvatar(raw) || FAKE_AVATAR.test(raw)) return '';
  return raw;
}

/**
 * URL que el cliente puede poner en <img>. Si hay foto real (clave o data:),
 * se sirve por /api/media/user/:id para que se vea en perfil, social y chats.
 */
export function publicListAvatar(value?: string | null, userId?: string): string {
  const raw = (value || '').trim();
  if (!raw || FAKE_AVATAR.test(raw)) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  const id = String(userId || '').trim();
  if (!id) {
    if (isInlineAvatar(raw)) return '';
    return publicAvatarRef(raw);
  }
  const version = isAvatarMediaKey(raw) ? raw.slice(-12) : 'live';
  return `/api/media/user/${id}?v=${encodeURIComponent(version)}`;
}

export async function saveAvatarBuffer(buffer: Buffer, mimeType: string): Promise<string> {
  const mime = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;
  if (!mime.startsWith('image/') || !isSupportedMediaType(mime)) {
    throw new Error('Usa JPG, PNG o WEBP');
  }
  if (buffer.length > MAX_BYTES) throw new Error('La foto pesa demasiado');
  const stored = await mediaStorage().save(buffer, mime);
  return stored.key;
}

export async function saveAvatarDataUrl(dataUrl: string): Promise<string> {
  const m = DATA_RE.exec(dataUrl.trim());
  if (!m) throw new Error('Foto de perfil no válida');
  const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  return saveAvatarBuffer(Buffer.from(m[2].replace(/\s/g, ''), 'base64'), mime);
}

async function dropOldKey(prev?: string | null) {
  const old = (prev || '').trim();
  if (!isAvatarMediaKey(old)) return;
  await mediaStorage().remove(old).catch(() => undefined);
}

export async function resolveIncomingAvatar(
  raw: string | undefined,
  prev?: string | null
): Promise<string | undefined> {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (!v) {
    await dropOldKey(prev);
    return '';
  }
  if (isInlineAvatar(v)) {
    const key = await saveAvatarDataUrl(v);
    await dropOldKey(prev);
    return key;
  }
  if (isAvatarMediaKey(v) || v.startsWith('http://') || v.startsWith('https://')) {
    if (v !== (prev || '').trim()) await dropOldKey(prev);
    return v;
  }
  throw new Error('Foto de perfil no válida');
}

export async function migrateInlineAvatars(): Promise<void> {
  const cursor = User.find({ avatar: /^data:image\// }).select('_id avatar').cursor();
  for await (const u of cursor) {
    try {
      const key = await saveAvatarDataUrl(String(u.avatar));
      await User.updateOne({ _id: u._id }, { $set: { avatar: key } });
    } catch (err) {
      logger.warn('[avatar] No se pudo pasar una foto de perfil al almacén', err);
    }
  }
}
