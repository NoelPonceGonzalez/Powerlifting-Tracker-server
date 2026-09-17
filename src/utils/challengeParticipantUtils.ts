import type { Gender } from './challengeScoring';

/** Tras populate, userId es el documento User; toString() vuelca el objeto entero. */
export function participantUserIdString(participant: { userId?: unknown }): string {
  const u = participant?.userId as { _id?: unknown; id?: unknown } | string | undefined;
  if (!u) return '';
  if (typeof u === 'string') return u;
  if (u._id != null) return String(u._id);
  if (u.id != null) return String(u.id);
  return String(u);
}

export function getBodyWeightAndGenderFromParticipant(participant: {
  userId?: { bodyWeight?: number; gender?: string; _id?: unknown } | unknown;
}): { bodyWeight: number; gender?: Gender } {
  const populatedUser = participant?.userId as { bodyWeight?: number; gender?: string } | undefined;
  const bodyWeight =
    typeof populatedUser?.bodyWeight === 'number' && populatedUser.bodyWeight > 0
      ? populatedUser.bodyWeight
      : 70;
  const gender =
    populatedUser?.gender === 'mujer' || populatedUser?.gender === 'hombre'
      ? (populatedUser.gender as Gender)
      : undefined;

  return { bodyWeight, gender };
}
