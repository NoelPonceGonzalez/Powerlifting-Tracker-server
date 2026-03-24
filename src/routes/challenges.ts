import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth';
import { Challenge } from '../models/Challenge';
import { Friendship } from '../models/Friendship';
import { User } from '../models/User';
import { Notification } from '../models/Notification';
import { body, validationResult } from 'express-validator';

const router = express.Router();

type ChallengeScoreType = 'max_reps' | 'weight' | 'seconds';
type Gender = 'hombre' | 'mujer';

type IpfGlCoefficients = {
  a: number;
  b: number;
  c: number;
};

const IPF_GL_COEFFICIENTS: Record<Gender, Record<'powerlifting' | 'squat' | 'bench' | 'deadlift', IpfGlCoefficients>> = {
  hombre: {
    powerlifting: { a: 1199.72839, b: 1025.18162, c: 0.00921 },
    squat: { a: 1236.25115, b: 1449.21864, c: 0.01644 },
    bench: { a: 381.22073, b: 733.79378, c: 0.02398 },
    deadlift: { a: 674.585, b: 1149.692, c: 0.015 },
  },
  mujer: {
    powerlifting: { a: 610.32796, b: 1045.59282, c: 0.03048 },
    squat: { a: 758.63878, b: 949.31382, c: 0.02435 },
    bench: { a: 221.82209, b: 357.00377, c: 0.02937 },
    deadlift: { a: 482.50024, b: 819.10084, c: 0.02963 },
  },
};

function getIpfGlCoefficients(exercise: string, gender: Gender): IpfGlCoefficients {
  const normalized = exercise.toLowerCase();

  if (/(bench|press banca|banca)/i.test(normalized)) {
    return IPF_GL_COEFFICIENTS[gender].bench;
  }
  if (/(squat|sentadilla)/i.test(normalized)) {
    return IPF_GL_COEFFICIENTS[gender].squat;
  }
  if (/(deadlift|peso muerto)/i.test(normalized)) {
    return IPF_GL_COEFFICIENTS[gender].deadlift;
  }

  return IPF_GL_COEFFICIENTS[gender].powerlifting;
}

function computeIpfGlPoints(value: number, bodyWeight: number, exercise: string, gender: Gender): number {
  const safeBodyWeight = bodyWeight > 0 ? bodyWeight : 70;
  const coeffs = getIpfGlCoefficients(exercise, gender);
  const denominator = coeffs.a - coeffs.b * Math.exp(-coeffs.c * safeBodyWeight);

  if (denominator <= 0) {
    return 0;
  }

  const points = (100 / denominator) * value;
  return Math.round(points * 100) / 100;
}

/** Calcula puntos según tipo de torneo */
function computeScore(
  type: ChallengeScoreType,
  value: number,
  bodyWeight: number,
  gender?: Gender,
  exercise = ''
): number {
  if (!bodyWeight || bodyWeight <= 0) bodyWeight = 70;
  const safeGender: Gender = gender === 'mujer' ? 'mujer' : 'hombre';
  const genderFactor = safeGender === 'mujer' ? 1.15 : 1;

  switch (type) {
    case 'max_reps':
      return Math.round((value / bodyWeight) * 100 * genderFactor);
    case 'weight':
      return computeIpfGlPoints(value, bodyWeight, exercise, safeGender);
    case 'seconds':
      return Math.round((value / bodyWeight) * 10 * genderFactor);
    default:
      return Math.round((value / bodyWeight) * 100 * genderFactor);
  }
}

function getBodyWeightAndGenderFromParticipant(participant: any): { bodyWeight: number; gender?: Gender } {
  const populatedUser = participant?.userId as any;
  const bodyWeight =
    typeof populatedUser?.bodyWeight === 'number' && populatedUser.bodyWeight > 0
      ? populatedUser.bodyWeight
      : 70;
  const gender = populatedUser?.gender === 'mujer' || populatedUser?.gender === 'hombre'
    ? populatedUser.gender
    : undefined;

  return { bodyWeight, gender };
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
      return {
        id: c._id.toString(),
        title: c.title,
        description: c.description || '',
        type: c.type,
        exercise: c.exercise,
        participants: c.participants.map(p => {
          const { bodyWeight, gender } = getBodyWeightAndGenderFromParticipant(p);
          const populatedUser = p.userId as any;
          const avatar = p.avatar || populatedUser?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(p.name || populatedUser?.name || 'U')}`;
          return {
            userId: p.userId.toString(),
            name: p.name,
            avatar,
            score: c.type === 'weight' ? computeScore('weight', p.value, bodyWeight, gender, c.exercise) : p.score,
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

      const creator = await User.findById(userId);
      const creatorName = creator?.name || creator?.email || 'Usuario';
      const creatorAvatar = creator?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(creatorName)}`;

      const challenge = new Challenge({
        createdBy: userId,
        title,
        description: description || '',
        type,
        exercise,
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
          score: created!.type === 'weight' ? computeScore('weight', p.value, bodyWeight, gender, created!.exercise) : p.score,
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
      const score = computeScore(
        challenge.type as ChallengeScoreType,
        value,
        bodyWeight,
        gender,
        challenge.exercise
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

      const updated = await Challenge.findById(challenge._id)
        .populate('createdBy', 'name email avatar')
        .populate('participants.userId', 'name email avatar bodyWeight gender');

      res.json({
        id: updated!._id.toString(),
        title: updated!.title,
        description: updated!.description || '',
        type: updated!.type,
        exercise: updated!.exercise,
        participants: updated!.participants.map(p => {
          const { bodyWeight, gender } = getBodyWeightAndGenderFromParticipant(p);
          const populatedUser = p.userId as any;
          const avatar = p.avatar || populatedUser?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(p.name || populatedUser?.name || 'U')}`;
          return {
            userId: p.userId.toString(),
            name: p.name,
            avatar,
            score: updated!.type === 'weight' ? computeScore('weight', p.value, bodyWeight, gender, updated!.exercise) : p.score,
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
