import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth';
import { Challenge } from '../models/Challenge';
import { Friendship } from '../models/Friendship';
import { User } from '../models/User';
import { Notification } from '../models/Notification';
import { body, validationResult } from 'express-validator';
import {
  computeChallengeScore,
  computeDisplayScoreForChallengeParticipant,
  normalizeBodyWeightScoring,
  type ChallengeScoreType,
  type Gender,
} from '../utils/challengeScoring';
import { getBodyWeightAndGenderFromParticipant } from '../utils/challengeParticipantUtils';

const router = express.Router();

function displayScoreForParticipant(
  challenge: { type: string; exercise: string; usePointsSystem?: boolean; bodyWeightScoring?: string },
  p: { value: number },
  bodyWeight: number,
  gender?: Gender
): number {
  return computeDisplayScoreForChallengeParticipant(
    {
      type: challenge.type as ChallengeScoreType,
      exercise: challenge.exercise,
      usePointsSystem: challenge.usePointsSystem,
      bodyWeightScoring: challenge.bodyWeightScoring,
    },
    p.value,
    bodyWeight,
    gender
  );
}

/** Obtiene los ObjectIds de amigos de un usuario */
async function getFriendIds(userId: string): Promise<mongoose.Types.ObjectId[]> {
  const friendships = await Friendship.find({
    $or: [{ requester: userId }, { recipient: userId }],
    status: 'accepted',
  });
  return friendships.map(f => {
    const id = f.requester.toString() === userId ? f.recipient : f.requester;
    return id as mongoose.Types.ObjectId;
  });
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
          { description: { $regex: q, $options: 'i' } },
        ],
      });
    }

    const challenges = await Challenge.find({ $and: andConditions })
      .populate('createdBy', 'name email avatar')
      .populate('participants.userId', 'name email avatar bodyWeight gender')
      .sort({ endDate: 1 });

    const formatted = challenges.map(c => {
      const isFinished = c.endDate <= now;
      const createdAt = (c as { createdAt?: Date }).createdAt;
      return {
        id: c._id.toString(),
        title: c.title,
        description: c.description || '',
        type: c.type,
        exercise: c.exercise,
        usePointsSystem: c.usePointsSystem !== false,
        bodyWeightScoring: normalizeBodyWeightScoring(c.bodyWeightScoring),
        createdAt: createdAt ? new Date(createdAt).toISOString() : undefined,
        participants: c.participants.map(p => {
          const { bodyWeight, gender } = getBodyWeightAndGenderFromParticipant(p);
          const populatedUser = p.userId as any;
          const avatar = p.avatar || populatedUser?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(p.name || populatedUser?.name || 'U')}`;
          return {
            userId: p.userId.toString(),
            name: p.name,
            avatar,
            score: displayScoreForParticipant(c, p, bodyWeight, gender),
            value: p.value,
            initialValue: p.initialValue,
            initialScore: p.initialScore,
            joinedAt: p.joinedAt,
          };
        }),
        endDate: c.endDate,
        status: isFinished ? 'finished' : 'active',
        createdBy: {
          id: (c.createdBy as any)._id.toString(),
          name: (c.createdBy as any).name || (c.createdBy as any).email,
        },
      };
    });

    res.json(formatted);
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
    body('exercise').trim().notEmpty().withMessage('El ejercicio es requerido'),
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
        exercise,
        usePointsSystem,
        bodyWeightScoring,
        endDate: new Date(endDate),
        participants: [{
          userId: userId as any,
          name: creatorName,
          avatar: creatorAvatar,
          score: 0,
          value: 0,
          initialValue: 0,
          initialScore: 0,
          joinedAt: new Date(),
        }],
      });

      await challenge.save();

      const friendIds = await getFriendIds(userId);
      if (friendIds.length > 0) {
        const notifications = friendIds.map(fid => ({
          userId: fid,
          type: 'challenge_invite' as const,
          title: 'Nuevo torneo creado',
          message: `${creatorName} ha creado el torneo "${title}" (${exercise})`,
          relatedUserId: userId,
          relatedData: { challengeId: challenge._id.toString(), title, exercise },
        }));
        await Notification.insertMany(notifications);
        try {
          const { sendPushToUsers } = await import('../utils/push');
          await sendPushToUsers(
            friendIds.map(f => f.toString()),
            'Nuevo torneo creado',
            `${creatorName} ha creado el torneo "${title}" (${exercise})`,
            { type: 'challenge_invite', challengeId: challenge._id.toString() }
          );
        } catch (e) {
          console.error('[PUSH] Error challenge_invite:', e);
        }
      }

      const created = await Challenge.findById(challenge._id)
        .populate('createdBy', 'name email avatar')
        .populate('participants.userId', 'name email avatar bodyWeight gender');

      const participantsFormatted = created!.participants.map((p: any) => {
        const { bodyWeight, gender } = getBodyWeightAndGenderFromParticipant(p);
        return {
          userId: p.userId.toString(),
          name: p.name,
          avatar: p.avatar,
          score: displayScoreForParticipant(created!, p, bodyWeight, gender),
          value: p.value,
          initialValue: p.initialValue,
          initialScore: p.initialScore,
          joinedAt: p.joinedAt,
        };
      });

      res.status(201).json({
        id: created!._id.toString(),
        title: created!.title,
        description: created!.description || '',
        type: created!.type,
        exercise: created!.exercise,
        usePointsSystem: created!.usePointsSystem !== false,
        bodyWeightScoring: normalizeBodyWeightScoring(created!.bodyWeightScoring),
        createdAt: (created! as { createdAt?: Date }).createdAt
          ? new Date((created! as { createdAt?: Date }).createdAt!).toISOString()
          : new Date().toISOString(),
        participants: participantsFormatted,
        endDate: created!.endDate,
        status: created!.endDate > new Date() ? 'active' : 'finished',
        createdBy: {
          id: (created!.createdBy as any)._id.toString(),
          name: (created!.createdBy as any).name || (created!.createdBy as any).email,
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// PUT /api/challenges/:id/join - Unirse a un challenge (solo amigos del creador)
router.put(
  '/:id/join',
  authenticateToken,
  [
    body('value').isNumeric().withMessage('El valor (reps/kg/segundos) es requerido'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = (req as any).user.userId;
      const user = await User.findById(userId);
      const value = parseFloat(req.body.value);

      const challenge = await Challenge.findById(req.params.id);
      if (!challenge) {
        return res.status(404).json({ error: 'Challenge no encontrado' });
      }

      const endDate = new Date(challenge.endDate);
      if (endDate <= new Date()) {
        return res.status(400).json({ error: 'Este torneo ya ha finalizado' });
      }

      const creatorId = challenge.createdBy.toString();
      const isCreator = creatorId === userId;

      // Si no es el creador, verificar que es amigo del creador
      if (!isCreator) {
        const friendIds = await getFriendIds(creatorId);
        if (!friendIds.some(id => id.toString() === userId)) {
          return res.status(403).json({ error: 'Solo los amigos del creador pueden unirse a este torneo' });
        }
      }

      const bodyWeight = user?.bodyWeight ?? 70;
      const gender = user?.gender;
      const usePts = challenge.usePointsSystem !== false;
      const bwMode = normalizeBodyWeightScoring(challenge.bodyWeightScoring);
      const score = computeChallengeScore(
        challenge.type as ChallengeScoreType,
        value,
        bodyWeight,
        gender,
        challenge.exercise,
        usePts,
        bwMode
      );

      const existingParticipant = challenge.participants.find(
        p => p.userId.toString() === userId
      );

      if (existingParticipant) {
        existingParticipant.score = score;
        existingParticipant.value = value;
        // Mantener initialValue/initialScore/joinedAt para cálculo de progreso
      } else {
        challenge.participants.push({
          userId: userId as any,
          name: user?.name || user?.email || 'Usuario',
          avatar: user?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user?.name || user?.email || 'Usuario')}`,
          score,
          value,
          initialValue: value,
          initialScore: score,
          joinedAt: new Date(),
        });
      }

      await challenge.save();

      // Notificar al creador cuando un amigo se une (no si el creador actualiza su propia marca)
      if (!isCreator) {
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
            }
          );
        } catch (e) {
          console.error('[PUSH] Error challenge_join:', e);
        }
      }

      const updated = await Challenge.findById(challenge._id)
        .populate('createdBy', 'name email avatar')
        .populate('participants.userId', 'name email avatar bodyWeight gender');

      res.json({
        id: updated!._id.toString(),
        title: updated!.title,
        description: updated!.description || '',
        type: updated!.type,
        exercise: updated!.exercise,
        usePointsSystem: updated!.usePointsSystem !== false,
        bodyWeightScoring: normalizeBodyWeightScoring(updated!.bodyWeightScoring),
        createdAt: (updated! as { createdAt?: Date }).createdAt
          ? new Date((updated! as { createdAt?: Date }).createdAt!).toISOString()
          : undefined,
        participants: updated!.participants.map(p => {
          const { bodyWeight, gender } = getBodyWeightAndGenderFromParticipant(p);
          const populatedUser = p.userId as any;
          const avatar = p.avatar || populatedUser?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(p.name || populatedUser?.name || 'U')}`;
          return {
            userId: p.userId.toString(),
            name: p.name,
            avatar,
            score: displayScoreForParticipant(updated!, p, bodyWeight, gender),
            value: p.value,
            initialValue: p.initialValue,
            initialScore: p.initialScore,
            joinedAt: p.joinedAt,
          };
        }),
        endDate: updated!.endDate,
        status: updated!.endDate > new Date() ? 'active' : 'finished',
        createdBy: {
          id: (updated!.createdBy as any)._id.toString(),
          name: (updated!.createdBy as any).name || (updated!.createdBy as any).email,
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

export default router;
