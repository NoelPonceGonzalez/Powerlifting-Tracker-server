import {
  computeDisplayScoreForChallengeParticipant,
  normalizeBodyWeightScoring,
  normalizeChallengeExercises,
} from './challengeScoring';
import { getBodyWeightAndGenderFromParticipant, participantUserIdString } from './challengeParticipantUtils';
import { publicListAvatar } from './avatarMedia';

export function rankOfParticipant(
  participants: Array<{ userId: unknown; score: number; value: number }>,
  userId: string,
  usePointsSystem: boolean | undefined
): number {
  const usePts = usePointsSystem !== false;
  const ranked = [...participants].sort((a, b) => (usePts ? b.score - a.score : b.value - a.value));
  const idx = ranked.findIndex((p) => participantUserIdString(p as { userId: unknown }) === userId);
  return idx >= 0 ? idx + 1 : 0;
}

export function exerciseLabel(exercise?: string, exercises?: unknown): string {
  return normalizeChallengeExercises(exercise, exercises).join(' · ');
}

export function formatChallengeDoc(c: any) {
  const now = new Date();
  const createdAt = c.createdAt as Date | undefined;
  const exercises = normalizeChallengeExercises(c.exercise, c.exercises);
  return {
    id: c._id.toString(),
    title: c.title,
    description: c.description || '',
    type: c.type,
    exercise: exerciseLabel(c.exercise, exercises) || c.exercise,
    exercises,
    isPrivate: !!c.isPrivate,
    closeFriendsOnly: !!c.closeFriendsOnly,
    usePointsSystem: c.usePointsSystem !== false,
    bodyWeightScoring: normalizeBodyWeightScoring(c.bodyWeightScoring),
    createdAt: createdAt ? new Date(createdAt).toISOString() : undefined,
    participants: (c.participants || []).map((p: any) => {
      const { bodyWeight, gender } = getBodyWeightAndGenderFromParticipant(p);
      const populatedUser = p.userId as any;
      const avatar =
        p.avatar ||
        populatedUser?.avatar ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(p.name || populatedUser?.name || 'U')}`;
      return {
        userId: participantUserIdString(p),
        name: p.name,
        avatar,
        score: displayScoreForParticipant(c, p, bodyWeight, gender),
        value: p.value,
        lifts: Array.isArray(p.lifts) ? p.lifts : undefined,
        initialValue: p.initialValue,
        initialScore: p.initialScore,
        initialRank: typeof p.initialRank === 'number' ? p.initialRank : undefined,
        joinedAt: p.joinedAt,
      };
    }),
    endDate: c.endDate,
    status: c.endDate <= now ? 'finished' : 'active',
    createdBy: {
      id: String((c.createdBy as any)?._id || (c.createdBy as any)?.id || c.createdBy),
      name: (c.createdBy as any)?.name || (c.createdBy as any)?.email || 'Alguien',
      avatar: publicListAvatar(
        (c.createdBy as any)?.avatar,
        String((c.createdBy as any)?._id || (c.createdBy as any)?.id || '')
      ) || null,
    },
  };
}

function displayScoreForParticipant(
  challenge: { type: string; exercise: string; exercises?: string[]; usePointsSystem?: boolean; bodyWeightScoring?: string },
  p: { value: number; lifts?: { exercise: string; value: number }[] },
  bodyWeight: number,
  gender?: 'hombre' | 'mujer'
): number {
  return computeDisplayScoreForChallengeParticipant(
    {
      type: challenge.type as any,
      exercise: challenge.exercise,
      exercises: challenge.exercises,
      usePointsSystem: challenge.usePointsSystem,
      bodyWeightScoring: challenge.bodyWeightScoring,
    },
    p.value,
    bodyWeight,
    gender,
    p.lifts
  );
}
