export const CHAT_MEDIA_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function chatMediaExpiresAt(from = new Date()): Date {
  return new Date(from.getTime() + CHAT_MEDIA_LIFETIME_MS);
}

export function isChatMediaLive(row: {
  mediaKey?: string | null;
  mediaExpiresAt?: Date | string | null;
  createdAt?: Date | string;
}): boolean {
  if (!row.mediaKey) return false;
  const exp = row.mediaExpiresAt
    ? new Date(row.mediaExpiresAt).getTime()
    : row.createdAt
      ? new Date(row.createdAt).getTime() + CHAT_MEDIA_LIFETIME_MS
      : 0;
  return Number.isFinite(exp) && exp > Date.now();
}
