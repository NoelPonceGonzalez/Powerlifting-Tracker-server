import mongoose from 'mongoose';
import { Challenge } from '../models/Challenge';
import { Notification } from '../models/Notification';
import { logger } from './logger';
import { computeDisplayScoreForChallengeParticipant } from './challengeScoring';
import { getBodyWeightAndGenderFromParticipant } from './challengeParticipantUtils';
import { sendPushToUsers } from './push';
import { broadcastSse } from './sse';

type RankRow = {
  userId: string;
  name: string;
  score: number;
  value: number;
};

function participantUserIdString(p: { userId: unknown }): string {
  const u = p.userId as { _id?: mongoose.Types.ObjectId; toString?: () => string } | mongoose.Types.ObjectId | string;
  if (u && typeof u === 'object' && '_id' in u && u._id) return String(u._id);
  if (u && typeof u === 'object' && 'toString' in u) return String(u);
  return String(u);
}

function rankParticipantsForChallenge(challenge: {
  type: string;
  exercise: string;
  usePointsSystem?: boolean;
  bodyWeightScoring?: unknown;
  participants: Array<{
    name: string;
    value: number;
    userId: unknown;
  }>;
}): RankRow[] {
  const usePts = challenge.usePointsSystem !== false;
  const rows: RankRow[] = challenge.participants.map(p => {
    const { bodyWeight, gender } = getBodyWeightAndGenderFromParticipant(p);
    const score = computeDisplayScoreForChallengeParticipant(
      {
        type: challenge.type,
        exercise: challenge.exercise,
        usePointsSystem: challenge.usePointsSystem,
        bodyWeightScoring: challenge.bodyWeightScoring,
      },
      p.value,
      bodyWeight,
      gender
    );
    return {
      userId: participantUserIdString(p),
      name: p.name,
      score,
      value: p.value,
    };
  });
  rows.sort((a, b) => {
    if (!usePts) return b.value - a.value;
    return b.score - a.score;
  });
  return rows;
}

function topWinners(ranked: RankRow[], usePoints: boolean): RankRow[] {
  if (ranked.length === 0) return [];
  const key: 'score' | 'value' = usePoints ? 'score' : 'value';
  const top = ranked[0][key];
  return ranked.filter(r => r[key] === top);
}

async function processOneChallenge(challenge: any): Promise<void> {
  const c = challenge;
  const participants = c.participants || [];

  if (participants.length === 0) {
    await Challenge.updateOne({ _id: c._id }, { $set: { winnerNotifiedAt: new Date() } });
    return;
  }

  const ranked = rankParticipantsForChallenge({
    type: c.type,
    exercise: c.exercise,
    usePointsSystem: c.usePointsSystem,
    bodyWeightScoring: c.bodyWeightScoring,
    participants,
  });
  const usePts = c.usePointsSystem !== false;
  const winners = topWinners(ranked, usePts);

  const title = `Torneo finalizado: "${c.title}"`;
  let message: string;
  if (winners.length === 1) {
    message = `Ganador: ${winners[0].name}.`;
  } else {
    message = `Empate en el 1.º puesto: ${winners.map(w => w.name).join(', ')}.`;
  }

  const firstWinnerOid =
    winners.length > 0 ? new mongoose.Types.ObjectId(winners[0].userId) : undefined;

  const notifDocs = participants.map((p: { userId: unknown }) => ({
    userId: participantUserIdString(p),
    type: 'challenge_winner' as const,
    title,
    message,
    relatedUserId: firstWinnerOid,
    relatedData: {
      challengeId: c._id.toString(),
      exercise: c.exercise,
      winnerNames: winners.map(w => w.name),
      winnerUserIds: winners.map(w => w.userId),
    },
    read: false,
  }));

  await Notification.insertMany(
    notifDocs.map((d: (typeof notifDocs)[number]) => ({
      ...d,
      userId: new mongoose.Types.ObjectId(d.userId),
    }))
  );

  const userIds = participants.map((p: { userId: unknown }) => participantUserIdString(p));
  try {
    await sendPushToUsers(userIds, title, message, {
      type: 'challenge_winner',
      challengeId: c._id.toString(),
      exercise: c.exercise,
    });
  } catch (e) {
    logger.error('[challenge_winner] push', e);
  }

  broadcastSse(userIds, 'challenge_update');

  await Challenge.updateOne({ _id: c._id }, { $set: { winnerNotifiedAt: new Date() } });
}

/**
 * Torneos con fecha de fin pasada y sin notificación de ganador.
 * Se ejecuta de forma periódica al arrancar el servidor.
 */
export async function processFinishedChallengeWinnerNotifications(): Promise<void> {
  const now = new Date();
  const pending = await Challenge.find({
    endDate: { $lte: now },
    $or: [{ winnerNotifiedAt: { $exists: false } }, { winnerNotifiedAt: null }],
  }).populate('participants.userId', 'name email avatar bodyWeight gender');

  for (const doc of pending) {
    try {
      await processOneChallenge(doc);
    } catch (e: any) {
      logger.error(`[challenge_winner] Error procesando torneo ${doc._id?.toString()}`, e);
    }
  }
}
