import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { authenticateToken } from '../middleware/auth';
import { Challenge } from '../models/Challenge';
import { mutualFriendIds } from '../utils/friendship';
import { audienceRecipients, blockedIdsFor, loadPrivacy } from '../utils/privacy';
import { User } from '../models/User';
import { Notification } from '../models/Notification';
import { body, validationResult } from 'express-validator';
import {
  computeMultiLiftScore,
  normalizeBodyWeightScoring,
  normalizeChallengeExercises,
  type ChallengeScoreType,
} from '../utils/challengeScoring';
import { participantUserIdString } from '../utils/challengeParticipantUtils';
import { exerciseLabel, formatChallengeDoc, rankOfParticipant } from '../utils/challengeFormat';
import { broadcastSse } from '../utils/sse';
import { publicListAvatar } from '../utils/avatarMedia';

const router = express.Router();

/** Amigos mutuos (las dos direcciones, o legado de un solo documento). */
async function getFriendIds(userId: string): Promise<mongoose.Types.ObjectId[]> {
  const ids = await mutualFriendIds(userId);
  return ids.map(id => new mongoose.Types.ObjectId(id));
}

// GET /api/challenges - Obtener challenges (propios, en los que participa, o de amigos). Filtros: status=active|finished, q=búsqueda
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const status = req.query.status as string | undefined; // 'active' | 'finished'
    const q = (req.query.q as string)?.trim().toLowerCase();

    const friendIds = await getFriendIds(userId);

    const now = new Date();
    const baseOr = [
      { createdBy: userId },
      { 'participants.userId': userId },
      { createdBy: { $in: friendIds } },
    ];
    const andConditions: any[] = [{ $or: baseOr }];
    if (status === 'active') andConditions.push({ endDate: { $gt: now } });
    if (status === 'finished') andConditions.push({ endDate: { $lte: now } });
    if (q && q.length >= 1) {
      andConditions.push({
        $or: [
          { title: { $regex: q, $options: 'i' } },
          { exercise: { $regex: q, $options: 'i' } },
          { exercises: { $elemMatch: { $regex: q, $options: 'i' } } },
          { description: { $regex: q, $options: 'i' } },
        ],
      });
    }

    const challenges = await Challenge.find({ $and: andConditions })
      .populate('createdBy', 'name email avatar')
      .populate('participants.userId', 'name email avatar bodyWeight gender')
      .sort({ endDate: 1 });

    const hidden = await blockedIdsFor(String(userId));
    const closeOnlyCreators = [
      ...new Set(
        challenges
          .filter(c => c.closeFriendsOnly)
          .map(c => String((c.createdBy as any)?._id ?? c.createdBy))
      ),
    ];
    const closeDocs = closeOnlyCreators.length
      ? await User.find({ _id: { $in: closeOnlyCreators } }).select('closeFriendIds').lean()
      : [];
    const closeByCreator = new Map(
      closeDocs.map(u => [String(u._id), new Set((u.closeFriendIds || []).map((id: unknown) => String(id)))])
    );
    const visible = challenges.filter(c => {
      const creatorId = String((c.createdBy as any)?._id ?? c.createdBy);
      if (hidden.has(creatorId) && creatorId !== String(userId)) return false;
      if (c.participants.some(p => participantUserIdString(p) === String(userId))) return true;
      if (creatorId === String(userId)) return true;
      if (c.closeFriendsOnly && !(closeByCreator.get(creatorId) || new Set()).has(String(userId))) {
        return false;
      }
      return true;
    });

    for (const c of visible) {
      let dirty = false;
      for (const p of c.participants) {
        if (p.initialRank != null || !(p.value > 0)) continue;
        const rank = rankOfParticipant(c.participants, participantUserIdString(p), c.usePointsSystem);
        if (rank > 0) {
          p.initialRank = rank;
          dirty = true;
        }
      }
      if (dirty) void c.save();
    }

    res.json(visible.map((c) => formatChallengeDoc(c)));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/challenges - Crear un nuevo challenge
router.post(
  '/',
  authenticateToken,
  [
    body('title').trim().notEmpty().withMessage('El título es requerido'),
    body('type').isIn(['max_reps', 'weight', 'seconds']).withMessage('Tipo inválido: max_reps, weight o seconds'),
    body('endDate').isISO8601().withMessage('La fecha de fin debe ser válida'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = (req as any).user.userId;
      const { title, type, exercise, endDate, description } = req.body;
      const exercises = normalizeChallengeExercises(exercise, req.body.exercises);
      if (exercises.length === 0) {
        return res.status(400).json({ error: 'Añade al menos un ejercicio' });
      }
      if (exercises.length > 8) {
        return res.status(400).json({ error: 'Máximo 8 ejercicios por torneo' });
      }
      const exerciseText = exerciseLabel(exercise, exercises);
      const isPrivate = req.body.isPrivate === true || req.body.isPrivate === 'true';
      const closeFriendsOnly = req.body.closeFriendsOnly === true || req.body.closeFriendsOnly === 'true';
      const rawPassword = typeof req.body.password === 'string' ? req.body.password.trim() : '';
      if (isPrivate && rawPassword.length < 4) {
        return res.status(400).json({ error: 'La contraseña del torneo privado debe tener al menos 4 caracteres' });
      }
      const usePointsSystem =
        req.body.usePointsSystem !== false && req.body.usePointsSystem !== 'false';
      const bodyWeightScoring = normalizeBodyWeightScoring(req.body.bodyWeightScoring);

      const creator = await User.findById(userId);
      const creatorName = creator?.name || creator?.email || 'Usuario';
      const creatorAvatar = creator?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(creatorName)}`;

      const challenge = new Challenge({
        createdBy: userId,
        title,
        description: description || '',
        type,
        exercise: exerciseText,
        exercises,
        isPrivate,
        closeFriendsOnly,
        passwordHash: isPrivate ? await bcrypt.hash(rawPassword, 10) : '',
        usePointsSystem,
        bodyWeightScoring,
        endDate: new Date(endDate),
        participants: [{
          userId: userId as any,
          name: creatorName,
          avatar: creatorAvatar,
          score: 0,
          value: 0,
          lifts: exercises.map((name) => ({ exercise: name, value: 0 })),
          initialValue: 0,
          initialScore: 0,
          joinedAt: new Date(),
        }],
      });

      await challenge.save();

      const friendIdsRaw = await getFriendIds(userId);
      const friendIds = (await audienceRecipients(
        String(userId),
        closeFriendsOnly ? 'close' : 'all',
        friendIdsRaw.map(id => id.toString())
      )).map(id => new mongoose.Types.ObjectId(id));
      const notifTitle = isPrivate ? 'Torneo privado' : 'Nuevo torneo creado';
      const notifBody = isPrivate
        ? `${creatorName} ha creado «${title}». Pídele la contraseña para unirte.`
        : `${creatorName} ha creado «${title}» (${exerciseText})`;
      if (friendIds.length > 0) {
        const notifications = friendIds.map(fid => ({
          userId: fid,
          type: 'challenge_invite' as const,
          title: notifTitle,
          message: notifBody,
          relatedUserId: userId,
          relatedData: { challengeId: challenge._id.toString(), title, exercise: exerciseText, isPrivate },
        }));
        await Notification.insertMany(notifications);
        try {
          const { sendPushToUsers } = await import('../utils/push');
          await sendPushToUsers(
            friendIds.map(f => f.toString()),
            notifTitle,
            notifBody,
            {
              type: 'challenge_invite',
              challengeId: challenge._id.toString(),
              relatedUserId: String(userId),
              screen: 'social',
              tab: 'challenges',
            }
          );
        } catch (e) {
          console.error('[PUSH] Error challenge_invite:', e);
        }
      }

      broadcastSse([userId, ...friendIds.map(f => f.toString())], 'challenge_update');

      const created = await Challenge.findById(challenge._id)
        .populate('createdBy', 'name email avatar')
        .populate('participants.userId', 'name email avatar bodyWeight gender');

      res.status(201).json(formatChallengeDoc(created));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// PUT /api/challenges/:id/join - Unirse a un challenge (solo amigos del creador)
router.put(
  '/:id/join',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.userId;
      const user = await User.findById(userId);

      const challenge = await Challenge.findById(req.params.id).select('+passwordHash');
      if (!challenge) {
        return res.status(404).json({ error: 'Challenge no encontrado' });
      }

      const endDate = new Date(challenge.endDate);
      if (endDate <= new Date()) {
        return res.status(400).json({ error: 'Este torneo ya ha finalizado' });
      }

      const creatorId = challenge.createdBy.toString();
      const isCreator = creatorId === userId;
      const existingParticipant = challenge.participants.find(
        p => participantUserIdString(p) === userId
      );

      if (!isCreator) {
        if (challenge.closeFriendsOnly) {
          const { close } = await loadPrivacy(creatorId);
          if (!close.has(String(userId))) {
            return res.status(403).json({ error: 'Este torneo es solo para mejores amigos' });
          }
        } else {
          const friendIds = await getFriendIds(creatorId);
          if (!friendIds.some(id => id.toString() === userId)) {
            return res.status(403).json({ error: 'Solo los amigos del creador pueden unirse a este torneo' });
          }
        }
      }

      if (challenge.isPrivate && !existingParticipant) {
        const given = typeof req.body.password === 'string' ? req.body.password : '';
        if (!challenge.passwordHash || !(await bcrypt.compare(given, challenge.passwordHash))) {
          return res.status(403).json({ error: 'Contraseña incorrecta' });
        }
      }

      const names = normalizeChallengeExercises(challenge.exercise, challenge.exercises);
      const rawLifts = Array.isArray(req.body.lifts) ? req.body.lifts : null;
      const lifts = (rawLifts && rawLifts.length > 0
        ? rawLifts
        : names.map((exercise, i) => ({
            exercise,
            value: i === 0 ? parseFloat(req.body.value) : NaN,
          }))
      )
        .map((l: any) => ({
          exercise: String(l?.exercise || '').trim(),
          value: parseFloat(l?.value),
        }))
        .filter((l: { exercise: string; value: number }) => l.exercise && Number.isFinite(l.value) && l.value >= 0);

      if (names.length > 1) {
        const missing = names.filter((n) => !lifts.some((l: { exercise: string }) => l.exercise.toLowerCase() === n.toLowerCase()));
        if (missing.length > 0) {
          return res.status(400).json({ error: `Faltan marcas: ${missing.join(', ')}` });
        }
      } else if (lifts.length === 0) {
        return res.status(400).json({ error: 'El valor (reps/kg/segundos) es requerido' });
      }

      const ordered = names.map((exercise) => {
        const found = lifts.find((l: { exercise: string }) => l.exercise.toLowerCase() === exercise.toLowerCase());
        return { exercise, value: found?.value ?? 0 };
      });

      const bodyWeight = user?.bodyWeight ?? 70;
      const gender = user?.gender;
      const usePts = challenge.usePointsSystem !== false;
      const bwMode = normalizeBodyWeightScoring(challenge.bodyWeightScoring);
      const { value, score } = computeMultiLiftScore(
        challenge.type as ChallengeScoreType,
        ordered,
        bodyWeight,
        gender,
        usePts,
        bwMode
      );

      if (existingParticipant) {
        existingParticipant.score = score;
        existingParticipant.value = value;
        existingParticipant.lifts = ordered;
      } else {
        challenge.participants.push({
          userId: userId as any,
          name: user?.name || user?.email || 'Usuario',
          avatar: publicListAvatar(user?.avatar, String(userId)),
          score,
          value,
          lifts: ordered,
          initialValue: value,
          initialScore: score,
          joinedAt: new Date(),
        });
      }

      const justJoined = !existingParticipant;
      const firstRealMark = Boolean(
        existingParticipant &&
        existingParticipant.initialRank == null &&
        value > 0
      );
      if (justJoined || firstRealMark) {
        const rank = rankOfParticipant(challenge.participants, userId, challenge.usePointsSystem);
        const target = challenge.participants.find((p) => participantUserIdString(p) === userId);
        if (target && rank > 0) target.initialRank = rank;
      }

      await challenge.save();

      if (!isCreator && !existingParticipant) {
        const joinerName = user?.name || user?.email || 'Alguien';
        try {
          const notif = new Notification({
            userId: creatorId,
            type: 'challenge_join',
            title: `${joinerName} se ha unido a tu torneo`,
            message: `"${challenge.title}" (${challenge.exercise})`,
            relatedUserId: userId,
            relatedData: { challengeId: challenge._id.toString() },
          });
          await notif.save();
          const { sendPushToUser } = await import('../utils/push');
          await sendPushToUser(
            creatorId,
            `${joinerName} se ha unido a tu torneo`,
            `"${challenge.title}" (${challenge.exercise})`,
            {
              type: 'challenge_join',
              challengeId: challenge._id.toString(),
              relatedUserId: String(userId),
              screen: 'social',
              tab: 'challenges',
            }
          );
        } catch (e) {
          console.error('[PUSH] Error challenge_join:', e);
        }
      }

      const participantIds = challenge.participants.map(p => participantUserIdString(p));
      if (!participantIds.includes(creatorId)) participantIds.push(creatorId);
      broadcastSse(participantIds, 'challenge_update');

      const updated = await Challenge.findById(challenge._id)
        .populate('createdBy', 'name email avatar')
        .populate('participants.userId', 'name email avatar bodyWeight gender');

      res.json(formatChallengeDoc(updated));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user.userId);
    const challenge = await Challenge.findById(req.params.id);
    if (!challenge) return res.status(404).json({ error: 'Torneo no encontrado' });
    const creatorId = String((challenge.createdBy as any)?._id || challenge.createdBy);
    if (creatorId !== userId) {
      return res.status(403).json({ error: 'Solo quien lo creó puede borrarlo' });
    }
    const participantIds = (challenge.participants || []).map((p) => participantUserIdString(p));
    if (!participantIds.includes(creatorId)) participantIds.push(creatorId);
    await Challenge.deleteOne({ _id: challenge._id });
    broadcastSse(participantIds, 'challenge_update');
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
