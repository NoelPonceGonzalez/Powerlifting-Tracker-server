import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth';
import { User } from '../models/User';
import { Friendship } from '../models/Friendship';
import { Notification } from '../models/Notification';
import { Routine } from '../models/Routine';
import { TrainingMax } from '../models/TrainingMax';
import { HistoryEntry } from '../models/HistoryEntry';
import { body, validationResult } from 'express-validator';
import { assembleFullRoutine } from '../utils/assembleRoutine';
import { broadcastSse } from '../utils/sse';

const router = express.Router();

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Misma regla que al crear rutina: mensual salvo `false` explícito (ciclo por semanas). */
function parseSameTemplateAllWeeks(v: unknown): boolean {
  if (v === false || v === 'false' || v === 0) return false;
  return true;
}

/** Cuenta creada solo tras completar registro: contraseña, nombre y género en MongoDB. */
const REGISTERED_USER_MATCH = {
  password: { $exists: true, $nin: [null, ''] },
  name: { $exists: true, $nin: [null, ''] },
  gender: { $in: ['hombre', 'mujer'] },
} as const;

// GET /api/social/search - Buscar usuarios por nombre
router.get(
  '/search',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = String((req as any).user.userId ?? '').trim();
      let userIdOid: mongoose.Types.ObjectId;
      try {
        userIdOid = new mongoose.Types.ObjectId(userId);
      } catch {
        return res.json([]);
      }

      const query = (req.query.q as string) || '';
      const trimmed = query.trim();
      if (trimmed.length < 1) {
        return res.json([]);
      }
      // No buscar por correo: solo por nombre visible.
      if (trimmed.includes('@')) {
        return res.json([]);
      }

      // Misma lógica que GET /api/social/friends: excluir amigos ya aceptados.
      const acceptedFriendships = await Friendship.find({
        $or: [{ requester: userIdOid }, { recipient: userIdOid }],
        status: 'accepted',
      }).lean();
      const acceptedFriendIdSet = new Set<string>();
      for (const f of acceptedFriendships) {
        const reqId = String((f.requester as any)?.toString?.() ?? f.requester);
        const recId = String((f.recipient as any)?.toString?.() ?? f.recipient);
        const otherId = reqId === userId ? recId : recId === userId ? reqId : null;
        if (otherId && otherId !== userId) acceptedFriendIdSet.add(otherId);
      }

      const escaped = escapeRegex(trimmed);

      // Coincidencia en nombre/username sin espacios (ej. "noelpon" → "Noel Ponce González").
      const nameCompactMatch = {
        $expr: {
          $regexMatch: {
            input: {
              $replaceAll: {
                input: { $toLower: { $ifNull: ['$name', ''] } },
                find: ' ',
                replacement: '',
              },
            },
            regex: escaped,
            options: 'i',
          },
        },
      };
      // Solo por nombre visible (no email / Gmail).
      const users = await User.find({
        _id: { $ne: userIdOid },
        ...REGISTERED_USER_MATCH,
        $or: [{ name: { $regex: escaped, $options: 'i' } }, nameCompactMatch],
      })
        .select('name email username avatar bodyWeight')
        .limit(30);

      const usersForResults = users.filter(u => !acceptedFriendIdSet.has(u._id.toString()));

      // Estado pendiente / rechazado respecto a cada candidato (los aceptados ya están fuera).
      const userIds = usersForResults.map(u => u._id);
      const friendships =
        userIds.length === 0
          ? []
          : await Friendship.find({
              $or: [
                { requester: userIdOid, recipient: { $in: userIds } },
                { requester: { $in: userIds }, recipient: userIdOid },
              ],
            });

      const friendshipMap = new Map<string, string>();
      const selfId = userIdOid.toString();
      friendships.forEach(f => {
        const otherUserId = f.requester.toString() === selfId ? f.recipient.toString() : f.requester.toString();
        friendshipMap.set(otherUserId, f.status);
      });

      const results = usersForResults.map(user => ({
          id: user._id.toString(),
          name: user.name || (user as any).username || user.email,
          email: user.email,
          username: (user as any).username,
          avatar:
            user.avatar ||
            `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name || (user as any).username || user.email)}`,
          bodyWeight: user.bodyWeight,
          friendshipStatus: friendshipMap.get(user._id.toString()) || null,
        }));

      res.json(results);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/** Usuarios sugeridos para enviar solicitud: excluye tú, amigos y cualquier solicitud (pendiente o ya resuelta con esa persona). */
router.get('/suggestions', authenticateToken, async (req: Request, res: Response) => {
  try {
    const rawUserId = String((req as any).user.userId ?? '');
    let userIdOid: mongoose.Types.ObjectId;
    try {
      userIdOid = new mongoose.Types.ObjectId(rawUserId);
    } catch {
      return res.json([]);
    }

    const friendships = await Friendship.find({
      $or: [{ requester: userIdOid }, { recipient: userIdOid }],
    })
      .select('requester recipient')
      .lean();

    const exclude = new Set<string>([userIdOid.toString()]);
    const selfStr = userIdOid.toString();
    for (const f of friendships) {
      const reqId = String(f.requester);
      const recId = String(f.recipient);
      const other = reqId === selfStr ? recId : recId === selfStr ? reqId : null;
      if (other) exclude.add(other);
    }

    const excludeIds = [...exclude].map(id => new mongoose.Types.ObjectId(id));
    const available = await User.countDocuments({
      _id: { $nin: excludeIds },
      ...REGISTERED_USER_MATCH,
    });
    if (available === 0) return res.json([]);

    const sampleSize = Math.min(15, available);
    const users = await User.aggregate([
      { $match: { _id: { $nin: excludeIds }, ...REGISTERED_USER_MATCH } },
      { $sample: { size: sampleSize } },
      { $project: { name: 1, email: 1, username: 1, avatar: 1, bodyWeight: 1 } },
    ]);

    const results = users.map((user: any) => ({
      id: user._id.toString(),
      name: user.name || user.username || user.email,
      email: user.email,
      username: user.username,
      avatar: user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name || user.username || user.email)}`,
      bodyWeight: user.bodyWeight,
      friendshipStatus: null,
    }));

    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/social/friends/:friendId/routine - Obtener rutina activa de un amigo (solo amigos)
router.get('/friends/:friendId/routine', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const friendId = req.params.friendId;

    const friendship = await Friendship.findOne({
      $or: [
        { requester: userId, recipient: friendId, status: 'accepted' },
        { requester: friendId, recipient: userId, status: 'accepted' },
      ],
    });
    if (!friendship) {
      return res.status(403).json({ error: 'Solo puedes ver la rutina de tus amigos' });
    }

    const friendObjectId = new mongoose.Types.ObjectId(String(friendId));
    const routine = await Routine.findOne({ userId: friendObjectId, isActive: true }).lean();
    if (!routine || (routine as { hiddenFromSocial?: boolean }).hiddenFromSocial) {
      return res.json(null);
    }

    const assembled = (await assembleFullRoutine(routine)) as Record<string, unknown>;
    const stawRaw = (routine as { sameTemplateAllWeeks?: unknown }).sameTemplateAllWeeks;
    const stawAssembled = (assembled as { sameTemplateAllWeeks?: unknown }).sameTemplateAllWeeks;
    const sameTemplateAllWeeks = parseSameTemplateAllWeeks(
      stawRaw !== undefined && stawRaw !== null ? stawRaw : stawAssembled
    );

    const wto = (assembled as { weekTypeOverrides?: unknown[] }).weekTypeOverrides;
    const weekTypeOverrides = Array.isArray(wto) ? wto : [];

    res.json({
      id: String(assembled._id ?? assembled.id ?? ''),
      name: assembled.name,
      weeks: assembled.weeks,
      baseTemplate: assembled.baseTemplate,
      versions: assembled.versions,
      logs: assembled.logs,
      weekTypeOverrides,
      sameTemplateAllWeeks,
      cycleLength: (routine as { cycleLength?: number }).cycleLength ?? 4,
      skippedWeeks: Array.isArray((routine as { skippedWeeks?: number[] }).skippedWeeks)
        ? (routine as { skippedWeeks: number[] }).skippedWeeks
        : [],
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/social/friends/:friendId/profile - Perfil público de un amigo (nombre, avatar, TMs)
router.get('/friends/:friendId/profile', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const friendId = req.params.friendId;

    const friendship = await Friendship.findOne({
      $or: [
        { requester: userId, recipient: friendId, status: 'accepted' },
        { requester: friendId, recipient: userId, status: 'accepted' },
      ],
    });
    if (!friendship) {
      return res.status(403).json({ error: 'Solo puedes ver el perfil de tus amigos' });
    }

    const friend = await User.findById(friendId).select('name avatar').lean();
    if (!friend) return res.status(404).json({ error: 'Usuario no encontrado' });

    const activeRoutine = await Routine.findOne({ userId: friendId, isActive: true }).select('_id').lean();
    const includeAllTms = String(req.query.includeAllTms || '') === '1' || String(req.query.includeAllTms || '') === 'true';

    const sharedTms = activeRoutine?._id
      ? await TrainingMax.find({
          userId: friendId,
          routineId: activeRoutine._id,
          sharedToSocial: true,
        })
          .select('name value mode')
          .sort({ createdAt: 1 })
          .lean()
      : [];

    const allTms =
      includeAllTms && activeRoutine?._id
        ? await TrainingMax.find({
            userId: friendId,
            routineId: activeRoutine._id,
          })
            .select('name mode linkedExercise')
            .sort({ createdAt: 1 })
            .lean()
        : [];

    res.json({
      name: friend.name || 'Usuario',
      avatar: friend.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(friend.name || 'U')}`,
      trainingMaxes: sharedTms.map((t: any) => ({ name: t.name, value: t.value, mode: t.mode })),
      ...(includeAllTms
        ? {
            trainingMaxesAll: allTms.map((t: any) => ({
              name: t.name,
              mode: t.mode,
              ...(t.linkedExercise ? { linkedExercise: t.linkedExercise } : {}),
            })),
          }
        : {}),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/social/friends - Obtener lista de amigos (siempre el OTRO usuario, nunca el actual)
router.get('/friends', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user.userId);
    let userIdOid: mongoose.Types.ObjectId;
    try {
      userIdOid = new mongoose.Types.ObjectId(userId);
    } catch {
      return res.json([]);
    }

    const friendships = await Friendship.find({
      $or: [{ requester: userIdOid }, { recipient: userIdOid }],
      status: 'accepted',
    }).lean();

    const friendIdSet = new Set<string>();
    for (const f of friendships) {
      const reqId = String((f.requester as any)?.toString?.() ?? f.requester);
      const recId = String((f.recipient as any)?.toString?.() ?? f.recipient);
      const otherId = reqId === userId ? recId : recId === userId ? reqId : null;
      if (otherId && otherId !== userId) friendIdSet.add(otherId);
    }
    const friendIds = Array.from(friendIdSet);

    if (friendIds.length === 0) return res.json([]);

    const users = await User.find({ _id: { $in: friendIds } }).select('name email avatar').lean();
    const userMap = new Map(users.map((u: any) => [String(u._id), u]));

    const friends = friendIds
      .filter(id => id !== userId)
      .map(id => {
        const u = userMap.get(id);
        const name = u?.name || u?.email || 'Usuario';
        return {
          id,
          name,
          email: u?.email,
          avatar: u?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}`,
        };
      });

    res.json(friends);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/social/requests - Obtener solicitudes de amistad (pendientes recibidas)
router.get('/requests', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user.userId ?? '');
    let recipientOid: mongoose.Types.ObjectId;
    try {
      recipientOid = new mongoose.Types.ObjectId(userId);
    } catch {
      return res.json([]);
    }

    const requests = await Friendship.find({
      recipient: recipientOid,
      status: 'pending',
    })
      .populate('requester', 'name email avatar')
      .sort({ createdAt: -1 });

    const formatted = requests.map(r => ({
      id: r._id.toString(),
      name: (r.requester as any).name || (r.requester as any).email,
      avatar: (r.requester as any).avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent((r.requester as any).name || (r.requester as any).email)}`,
      status: r.status,
    }));

    res.json(formatted);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/social/requests - Enviar solicitud de amistad
router.post(
  '/requests',
  authenticateToken,
  [
    body('userId').notEmpty().withMessage('El ID del usuario es requerido'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const requesterId = (req as any).user.userId;
      const recipientId = req.body.userId;

      if (requesterId === recipientId) {
        return res.status(400).json({ error: 'No puedes enviarte una solicitud a ti mismo' });
      }

      // Verificar que el usuario existe
      const recipient = await User.findById(recipientId);
      if (!recipient) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      // Verificar si ya existe una solicitud
      const existing = await Friendship.findOne({
        $or: [
          { requester: requesterId, recipient: recipientId },
          { requester: recipientId, recipient: requesterId },
        ],
      });

      if (existing) {
        return res.status(400).json({ error: 'Ya existe una solicitud de amistad con este usuario' });
      }

      // Crear solicitud
      const friendship = new Friendship({
        requester: requesterId,
        recipient: recipientId,
        status: 'pending',
      });

      await friendship.save();

      // Crear notificación para el destinatario
      const requester = await User.findById(requesterId);
      const requesterName = requester?.name || requester?.email || 'Alguien';
      const notification = new Notification({
        userId: recipientId,
        type: 'friend_request',
        title: `${requesterName} quiere ser tu amigo`,
        message: 'Toca para ver la solicitud',
        relatedUserId: requesterId,
      });

      await notification.save();

      try {
        const { sendPushToUser } = await import('../utils/push');
        await sendPushToUser(
          String(recipientId),
          `${requesterName} quiere ser tu amigo`,
          'Toca para ver la solicitud',
          { type: 'friend_request', relatedUserId: String(requesterId) }
        );
      } catch (e) {
        console.error('[PUSH] Error friend_request:', e);
      }

      broadcastSse([requesterId, recipientId], 'social_update');

      res.status(201).json(friendship);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// PUT /api/social/requests/:id/accept - Aceptar solicitud de amistad
router.put('/requests/:id/accept', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const requestId = req.params.id;

    const friendship = await Friendship.findOne({
      _id: requestId,
      recipient: userId,
      status: 'pending',
    });

    if (!friendship) {
      return res.status(404).json({ error: 'Solicitud no encontrada' });
    }

    friendship.status = 'accepted';
    await friendship.save();

    // Crear notificación para el solicitante
    const currentUser = await User.findById(userId);
    const acceptorName = currentUser?.name || currentUser?.email || 'Alguien';
    const notification = new Notification({
      userId: friendship.requester,
      type: 'friend_accepted',
      title: `${acceptorName} ha aceptado tu solicitud`,
      message: '¡Ahora sois amigos!',
      relatedUserId: userId,
    });

    await notification.save();

    // Push al móvil del solicitante (llega aunque la app esté cerrada)
    try {
      const { sendPushToUser } = await import('../utils/push');
      await sendPushToUser(
        String(friendship.requester),
        `${acceptorName} ha aceptado tu solicitud`,
        '¡Ahora sois amigos!',
        { type: 'friend_accepted', relatedUserId: String(userId) }
      );
    } catch (e) {
      console.error('[PUSH] Error friend_accepted:', e);
    }

    broadcastSse([userId, friendship.requester.toString()], 'social_update');

    res.json(friendship);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/social/requests/:id/reject - Rechazar solicitud de amistad
router.put('/requests/:id/reject', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const requestId = req.params.id;

    const friendship = await Friendship.findOneAndUpdate(
      {
        _id: requestId,
        recipient: userId,
        status: 'pending',
      },
      { status: 'rejected' },
      { new: true }
    );

    if (!friendship) {
      return res.status(404).json({ error: 'Solicitud no encontrada' });
    }

    broadcastSse([userId, friendship.requester.toString()], 'social_update');

    res.json(friendship);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/social/friends/:friendId - Dejar de ser amigo (elimina la relación para ambos usuarios)
router.delete('/friends/:friendId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user.userId);
    const friendId = String(req.params.friendId).trim();

    if (userId === friendId) {
      return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
    }

    const result = await Friendship.deleteMany({
      status: 'accepted',
      $or: [
        { requester: userId, recipient: friendId },
        { requester: friendId, recipient: userId },
      ],
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'No existe amistad con este usuario' });
    }

    broadcastSse([userId, friendId], 'social_update');

    res.json({ message: 'Amistad eliminada' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

function computeAggregate(tms: Array<{ value: number; mode: string }>): number {
  const w = tms.filter(t => t.mode === 'weight');
  const r = tms.filter(t => t.mode === 'reps');
  const s = tms.filter(t => t.mode === 'seconds');
  const sumW = w.reduce((a, t) => a + (t.value || 0), 0);
  const sumR = r.reduce((a, t) => a + (t.value || 0), 0);
  const sumS = s.reduce((a, t) => a + (t.value || 0), 0);
  const nModes = [w.length > 0, r.length > 0, s.length > 0].filter(Boolean).length;
  if (nModes <= 1) return sumW + sumR + sumS;
  return Math.round((sumW + sumR / 5 + sumS / 60) * 100) / 100;
}

/** Mejora % de la rutina: primer snapshot del historial vs TM actuales (vivos). */
async function routineImprovementForUser(userOid: mongoose.Types.ObjectId): Promise<{
  improvementPct: number | null;
  snapshotCount: number;
  routineName?: string;
}> {
  const routine = await Routine.findOne({ userId: userOid, isActive: true }).lean();
  if (!routine) {
    return { improvementPct: null, snapshotCount: 0, routineName: undefined };
  }
  const rid = routine._id instanceof mongoose.Types.ObjectId ? routine._id : new mongoose.Types.ObjectId(String(routine._id));
  const history = await HistoryEntry.find({ userId: userOid, routineId: rid })
    .sort({ dateISO: 1, year: 1, planWeek: 1, dayOfWeek: 1, createdAt: 1 })
    .lean();
  const name = String((routine as { name?: string }).name || 'Rutina');

  const currentTms = await TrainingMax.find({ userId: userOid, routineId: rid }).lean();
  const currentTotal = computeAggregate(currentTms.map(t => ({ value: t.value, mode: t.mode })));

  if (history.length === 0) {
    return { improvementPct: currentTotal > 0 ? 0 : null, snapshotCount: 0, routineName: name };
  }

  const first = history[0] as { total?: number };
  const t0 = Number(first.total) || 0;
  const t1 = currentTotal;

  let improvementPct: number;
  if (t0 <= 0) {
    improvementPct = t1 > t0 ? 100 : 0;
  } else {
    improvementPct = Math.round(((t1 - t0) / t0) * 100);
  }
  return { improvementPct, snapshotCount: history.length, routineName: name };
}

// GET /api/social/friends/routine-progress — ranking de mejora de rutina (tú + amigos)
router.get('/friends/routine-progress', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user.userId ?? '');
    let userIdOid: mongoose.Types.ObjectId;
    try {
      userIdOid = new mongoose.Types.ObjectId(userId);
    } catch {
      return res.json({ entries: [] });
    }

    const friendships = await Friendship.find({
      $or: [{ requester: userIdOid }, { recipient: userIdOid }],
      status: 'accepted',
    }).lean();

    const friendIdSet = new Set<string>();
    for (const f of friendships) {
      const reqId = String((f.requester as any)?.toString?.() ?? f.requester);
      const recId = String((f.recipient as any)?.toString?.() ?? f.recipient);
      const otherId = reqId === userId ? recId : recId === userId ? reqId : null;
      if (otherId && otherId !== userId) friendIdSet.add(otherId);
    }
    const friendIds = Array.from(friendIdSet);

    const targetIds = [userId, ...friendIds];

    const users = await User.find({ _id: { $in: targetIds.map(id => new mongoose.Types.ObjectId(id)) } })
      .select('name email avatar')
      .lean();

    const userMap = new Map(users.map((u: any) => [String(u._id), u]));

    const entries: Array<{
      userId: string;
      name: string;
      avatar: string;
      isSelf: boolean;
      routineName?: string;
      snapshotCount: number;
      improvementPct: number | null;
    }> = [];

    for (const oid of targetIds) {
      const uid = new mongoose.Types.ObjectId(oid);
      const u = userMap.get(oid);
      const name = u?.name || u?.email || 'Usuario';
      const avatar = u?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}`;
      const stats = await routineImprovementForUser(uid);
      entries.push({
        userId: oid,
        name,
        avatar,
        isSelf: oid === userId,
        routineName: stats.routineName,
        snapshotCount: stats.snapshotCount,
        improvementPct: stats.improvementPct,
      });
    }

    entries.sort((a, b) => {
      const ap = a.improvementPct;
      const bp = b.improvementPct;
      const av = ap == null ? -1e9 : ap;
      const bv = bp == null ? -1e9 : bp;
      if (bv !== av) return bv - av;
      return a.name.localeCompare(b.name, 'es');
    });

    res.json({ entries });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
