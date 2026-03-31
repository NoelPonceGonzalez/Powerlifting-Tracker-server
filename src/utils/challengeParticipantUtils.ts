import type { Gender } from './challengeScoring';

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
