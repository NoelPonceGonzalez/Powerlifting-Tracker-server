import express, { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth';
import { User } from '../models/User';
import { Friendship } from '../models/Friendship';
import { Notification } from '../models/Notification';
import { Routine } from '../models/Routine';
import { TrainingMax } from '../models/TrainingMax';
import { HistoryEntry } from '../models/HistoryEntry';
import { HistoryTmSnapshot } from '../models/HistoryTmSnapshot';
import { Post } from '../models/Post';
import { CoachRequest } from '../models/CoachRequest';
import { ChatMessage } from '../models/ChatMessage';
import { ChatGroup } from '../models/ChatGroup';
import { ChatGroupInvite } from '../models/ChatGroupInvite';
import { ChatHide } from '../models/ChatHide';
import { ChatRequest } from '../models/ChatRequest';
import { body, validationResult } from 'express-validator';
import { assembleFullRoutine } from '../utils/assembleRoutine';
import { broadcastSse, isUserOnline } from '../utils/sse';
import { isSupportedMediaType, mediaKindFromMime, mediaStorage } from '../utils/mediaStorage';
import { chatMediaExpiresAt, isChatMediaLive } from '../utils/chatMedia';
import { areFriends, canSeeContent, connectionSets, describeRelation, follows, loadPair, mutualFriendIds } from '../utils/friendship';
import { chatIsOpen, ensurePendingChatRequest, wipeDmBothSides } from '../utils/chatAccess';
import { publicListAvatar } from '../utils/avatarMedia';

const router = express.Router();

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
});

function optionalChatFile(req: Request, res: Response, next: NextFunction) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('multipart/form-data')) return next();
  chatUpload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: 'El archivo es demasiado grande (máx. 80 MB)' });
    next();
  });
}

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

      const usersForResults = users;

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

      const mineByOther = new Map<string, typeof friendships[number]>();
      const theirsByOther = new Map<string, typeof friendships[number]>();
      const selfId = userIdOid.toString();
      friendships.forEach(f => {
        const isRequester = f.requester.toString() === selfId;
        const otherUserId = isRequester ? f.recipient.toString() : f.requester.toString();
        if (isRequester) mineByOther.set(otherUserId, f);
        else theirsByOther.set(otherUserId, f);
      });

      const results = usersForResults.map(user => {
        const oid = user._id.toString();
        const rel = describeRelation(mineByOther.get(oid), theirsByOther.get(oid));
        return {
          id: oid,
          name: user.name || (user as any).username || user.email,
          email: user.email,
          username: (user as any).username,
          avatar: publicListAvatar(user.avatar, oid),
          bodyWeight: user.bodyWeight,
          friendshipStatus: rel.status === 'none' ? null : rel.status,
          friendshipDirection: rel.direction,
          canSendRequest: rel.canSend,
        };
      });

      res.json(results);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

function suggestionCard(
  user: { _id: unknown; name?: string; username?: string; email?: string; avatar?: string; bodyWeight?: number },
  extra: { friendshipStatus?: 'follower' | null; friendshipDirection?: 'incoming' | null; reason: 'followback' | 'friends' | 'discover' }
) {
  const oid = String(user._id);
  return {
    id: oid,
    name: user.name || user.username || user.email,
    email: user.email,
    username: user.username,
    avatar: publicListAvatar(user.avatar, oid),
    bodyWeight: user.bodyWeight,
    friendshipStatus: extra.friendshipStatus ?? null,
    friendshipDirection: extra.friendshipDirection ?? null,
    canSendRequest: true,
    reason: extra.reason,
  };
}

function shuffleIds(ids: string[]) {
  const a = [...ids];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function asObjectIds(ids: Iterable<string>) {
  const out: mongoose.Types.ObjectId[] = [];
  for (const id of ids) {
    if (mongoose.isValidObjectId(id)) out.push(new mongoose.Types.ObjectId(id));
  }
  return out;
}

/** Sugerencias para seguir: te siguen, amigos de amigos, y gente nueva. Cambian en cada carga. */
router.get('/suggestions', authenticateToken, async (req: Request, res: Response) => {
  try {
    const rawUserId = String((req as any).user.userId ?? '');
    let userIdOid: mongoose.Types.ObjectId;
    try {
      userIdOid = new mongoose.Types.ObjectId(rawUserId);
    } catch {
      return res.json({ followBack: [], friends: [], discover: [] });
    }

    const { following, followers, pendingOutgoing } = await connectionSets(userIdOid.toString());
    const incomingPending = await Friendship.find({
      recipient: userIdOid,
      status: 'pending',
    })
      .select('requester')
      .lean();

    const exclude = new Set<string>([userIdOid.toString(), ...following, ...pendingOutgoing]);
    for (const row of incomingPending) exclude.add(String(row.requester));

    const followBackIds = shuffleIds([...followers].filter(id => !exclude.has(id))).slice(0, 6);

    const circleIds = asObjectIds(following);
    const theirFollows =
      circleIds.length === 0
        ? []
        : await Friendship.find({
            requester: { $in: circleIds },
            status: 'accepted',
          })
            .select('recipient')
            .lean();

    const fofSet = new Set<string>();
    for (const row of theirFollows) {
      const other = String(row.recipient);
      if (!exclude.has(other) && !followBackIds.includes(other)) fofSet.add(other);
    }
    const friendIds = shuffleIds([...fofSet]).slice(0, 8);

    const taken = new Set<string>([...exclude, ...followBackIds, ...friendIds]);
    const discoverUsers = await User.aggregate([
      { $match: { _id: { $nin: asObjectIds(taken) }, ...REGISTERED_USER_MATCH } },
      { $sample: { size: 8 } },
      { $project: { name: 1, email: 1, username: 1, avatar: 1, bodyWeight: 1 } },
    ]);

    const needed = [...new Set([...followBackIds, ...friendIds])];
    const knownUsers =
      needed.length === 0
        ? []
        : await User.find({ _id: { $in: asObjectIds(needed) }, ...REGISTERED_USER_MATCH })
            .select('name email username avatar bodyWeight')
            .lean();
    const byId = new Map(knownUsers.map(u => [String(u._id), u]));

    const followBack = followBackIds
      .map(id => byId.get(id))
      .filter(Boolean)
      .map(user =>
        suggestionCard(user as any, {
          reason: 'followback',
          friendshipStatus: 'follower',
          friendshipDirection: 'incoming',
        })
      );
    const friends = friendIds
      .map(id => byId.get(id))
      .filter(Boolean)
      .map(user => suggestionCard(user as any, { reason: 'friends' }));
    const discover = discoverUsers.map((user: any) => suggestionCard(user, { reason: 'discover' }));

    res.json({ followBack, friends, discover });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/social/friends/:friendId/routine - Obtener rutina activa de un amigo (solo amigos)
router.get('/friends/:friendId/routine', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const friendId = req.params.friendId;

    if (!(await canSeeContent(String(userId), String(friendId)))) {
      return res.status(403).json({ error: 'Solo puedes ver la rutina de a quien sigues' });
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

    if (!(await canSeeContent(String(userId), String(friendId)))) {
      return res.status(403).json({ error: 'Solo puedes ver el perfil de a quien sigues' });
    }

    const friend = await User.findById(friendId).select('name avatar bio coachId').lean();
    if (!friend) return res.status(404).json({ error: 'Usuario no encontrado' });

    const coach = friend.coachId
      ? await User.findById(friend.coachId).select('name avatar').lean()
      : null;
    /** Gente que le ha marcado como entrenador: en su perfil se ve a quién entrena. */
    const athleteCount = await User.countDocuments({ coachId: friendId });

    const activeRoutine = await Routine.findOne({ userId: friendId, isActive: true }).select('_id').lean();
    const includeAllTms = String(req.query.includeAllTms || '') === '1' || String(req.query.includeAllTms || '') === 'true';

    const sharedTms = activeRoutine?._id
      ? await TrainingMax.find({
          userId: friendId,
          routineId: activeRoutine._id,
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
      id: String(friend._id),
      name: friend.name || 'Usuario',
      avatar: publicListAvatar(friend.avatar, String(friend._id)),
      bio: friend.bio || '',
      coach: coach ? { id: String(coach._id), name: coach.name || 'Usuario', avatar: publicListAvatar(coach.avatar, String(coach._id)) || null } : null,
      athleteCount,
      trainingMaxes: sharedTms.map((t: any) => ({
        id: String(t._id),
        name: t.name,
        value: t.value,
        mode: t.mode,
      })),
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

    const friendIds = await mutualFriendIds(userId);

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
          avatar: publicListAvatar(u?.avatar, id),
        };
      });

    res.json(friends);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

function packPeople(
  ids: string[],
  userMap: Map<string, { name?: string; email?: string; avatar?: string }>,
  canSend: Set<string>,
  kindOf: (id: string) => 'mutual' | 'following' | 'follower'
) {
  return ids.map(id => {
    const u = userMap.get(id);
    const name = u?.name || u?.email || 'Usuario';
    return {
      id,
      name,
      avatar: publicListAvatar(u?.avatar, id),
      canSendRequest: canSend.has(id),
      kind: kindOf(id),
    };
  });
}

/** Seguidos, seguidores y la mezcla (amigos + un solo lado). */
router.get('/connections', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user.userId ?? '');
    try {
      new mongoose.Types.ObjectId(userId);
    } catch {
      return res.json({ following: [], followers: [], all: [] });
    }

    const { following, followers, mutual, pendingOutgoing } = await connectionSets(userId);
    const allIds = Array.from(new Set([...following, ...followers, ...pendingOutgoing]));
    const users = allIds.length
      ? await User.find({ _id: { $in: allIds } }).select('name email avatar').lean()
      : [];
    const userMap = new Map(users.map((u: any) => [String(u._id), u]));
    const canSend = new Set(
      [...followers].filter(id => !following.has(id) && !pendingOutgoing.has(id))
    );

    const kindOf = (id: string) =>
      mutual.has(id) ? 'mutual' as const : following.has(id) ? 'following' as const : 'follower' as const;

    res.json({
      following: packPeople(Array.from(following), userMap, canSend, kindOf),
      followers: packPeople(Array.from(followers), userMap, canSend, kindOf),
      all: packPeople(Array.from(new Set([...following, ...followers])), userMap, canSend, kindOf),
      sent: packPeople(Array.from(pendingOutgoing), userMap, new Set(), () => 'following'),
    });
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
      userId: (r.requester as any)?._id?.toString?.() || String((r.requester as any)?._id || ''),
      name: (r.requester as any).name || (r.requester as any).email,
      avatar: publicListAvatar((r.requester as any).avatar, (r.requester as any)?._id?.toString?.() || String((r.requester as any)?._id || '')),
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

      const { mine } = await loadPair(String(requesterId), String(recipientId));
      if (await areFriends(String(requesterId), String(recipientId))) {
        return res.status(400).json({ error: 'Ya sois amigos' });
      }
      if (mine?.status === 'pending') {
        return res.status(400).json({ error: 'Ya le enviaste una solicitud; está pendiente de respuesta' });
      }
      if (mine?.status === 'accepted') {
        return res.status(400).json({ error: 'Ya le enviaste la solicitud' });
      }

      let friendship;
      const mineDoc = await Friendship.findOne({ requester: requesterId, recipient: recipientId });
      if (mineDoc) {
        mineDoc.status = 'pending';
        mineDoc.followOnly = false;
        await mineDoc.save();
        friendship = mineDoc;
      } else {
        friendship = new Friendship({
          requester: requesterId,
          recipient: recipientId,
          status: 'pending',
          followOnly: false,
        });
        await friendship.save();
      }

      const requester = await User.findById(requesterId);
      const requesterName = requester?.name || requester?.email || 'Alguien';
      const notification = new Notification({
        userId: recipientId,
        type: 'friend_request',
        title: `${requesterName} te ha enviado una solicitud`,
        message: 'Toca para ver la solicitud de seguimiento',
        relatedUserId: requesterId,
      });

      await notification.save();

      try {
        const { sendPushToUser } = await import('../utils/push');
        await sendPushToUser(
          String(recipientId),
          `${requesterName} te ha enviado una solicitud`,
          'Toca para ver la solicitud de seguimiento',
          { type: 'friend_request', relatedUserId: String(requesterId) }
        );
      } catch (e) {
        console.error('[PUSH] Error friend_request:', e);
      }

      broadcastSse([requesterId, recipientId], 'social_update');

      res.status(201).json(friendship);
    } catch (error: any) {
      if (error?.code === 11000) {
        return res.status(400).json({ error: 'Ya existe una solicitud con este usuario' });
      }
      console.error('[SOCIAL] Error enviando solicitud:', error);
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
    friendship.followOnly = false;
    await friendship.save();

    const requesterId = friendship.requester;
    await Friendship.findOneAndUpdate(
      { requester: userId, recipient: requesterId },
      { $set: { status: 'accepted', followOnly: false } },
      { upsert: true }
    );

    const currentUser = await User.findById(userId);
    const requesterUser = await User.findById(requesterId).select('name email avatar');
    const acceptorName = currentUser?.name || currentUser?.email || 'Alguien';
    const requesterName = requesterUser?.name || requesterUser?.email || 'Alguien';
    await Notification.create({
      userId: requesterId,
      type: 'friend_accepted',
      title: `${acceptorName} ha aceptado tu solicitud`,
      message: '¡Ahora sois amigos!',
      relatedUserId: userId,
    });

    try {
      const { sendPushToUser } = await import('../utils/push');
      await sendPushToUser(
        String(requesterId),
        `${acceptorName} ha aceptado tu solicitud`,
        '¡Ahora sois amigos!',
        { type: 'friend_accepted', relatedUserId: String(userId) }
      );
    } catch (e) {
      console.error('[PUSH] Error friend_accepted:', e);
    }

    broadcastSse([userId, String(requesterId)], 'social_update');

    res.json({
      id: friendship._id.toString(),
      status: 'accepted',
      friends: true,
      friend: {
        id: String(requesterId),
        name: requesterName,
        avatar: publicListAvatar(requesterUser?.avatar, String(requesterId)),
      },
    });
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

    // Se borra la relación entera: un documento residual impediría volver a enviar solicitud.
    const result = await Friendship.deleteMany({
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

    const friendIds = await mutualFriendIds(userId);

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
      const avatar = publicListAvatar(u?.avatar, oid);
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

/**
 * Perfil de cualquier usuario para la pantalla estilo Instagram. Sin ser amigos se ve la
 * portada (nombre, bio, contadores) pero no las marcas: eso queda para el círculo cercano.
 */
router.get('/users/:userId/profile', authenticateToken, async (req: Request, res: Response) => {
  try {
    const viewerId = (req as any).user.userId;
    const targetId = req.params.userId;
    if (!mongoose.isValidObjectId(targetId)) return res.status(400).json({ error: 'Usuario inválido' });

    const target = await User.findById(targetId).select('name username avatar bio coachId').lean();
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    const isSelf = String(targetId) === String(viewerId);
    const pair = isSelf ? { mine: null, theirs: null } : await loadPair(String(viewerId), String(targetId));
    const rel = describeRelation(pair.mine, pair.theirs);
    const isFriend = isSelf || rel.status === 'accepted' || rel.status === 'following';

    const [postCount, sets, athleteCount, coach] = await Promise.all([
      Post.countDocuments({ userId: targetId, kind: 'post' }),
      connectionSets(String(targetId)),
      User.countDocuments({ coachId: targetId }),
      target.coachId ? User.findById(target.coachId).select('name avatar').lean() : null,
    ]);
    const friendCount = sets.mutual.size;

    /** Pedir que me entrene (yo soy el alumno) o invitarle a entrenarle (yo soy el coach). */
    const [coachRequest, athleteInvite] = isSelf
      ? [null, null]
      : await Promise.all([
          CoachRequest.findOne({ athlete: viewerId, coach: targetId }).lean(),
          CoachRequest.findOne({ athlete: targetId, coach: viewerId }).lean(),
        ]);

    const activeRoutine = isFriend
      ? await Routine.findOne({ userId: targetId, isActive: true }).select('_id name').lean()
      : null;
    const trainingMaxes = activeRoutine?._id
      ? await TrainingMax.find({ userId: targetId, routineId: activeRoutine._id, sharedToSocial: true })
          .select('name value mode')
          .sort({ createdAt: 1 })
          .lean()
      : [];

    res.json({
      id: String(target._id),
      name: target.name || 'Usuario',
      username: target.username || null,
      avatar: publicListAvatar(target.avatar, String(target._id)) || null,
      bio: target.bio || '',
      isSelf,
      isFriend,
      friendshipStatus: isSelf ? 'self' : rel.status,
      friendshipDirection: isSelf ? null : rel.direction,
      canSendRequest: !isSelf && rel.canSend,
      postCount,
      friendCount,
      athleteCount,
      followerCount: sets.followers.size,
      followingCount: sets.following.size,
      coachRequestStatus: coachRequest?.status ?? 'none',
      athleteInviteStatus: athleteInvite?.status ?? 'none',
      iAmTheirCoach: !isSelf && String(target.coachId || '') === String(viewerId),
      routineName: activeRoutine?.name ?? null,
      coach: coach ? { id: String(coach._id), name: coach.name || 'Usuario', avatar: publicListAvatar(coach.avatar, String(coach._id)) || null } : null,
      trainingMaxes: trainingMaxes.map((t: any) => ({
        id: String(t._id),
        name: t.name,
        value: t.value,
        mode: t.mode,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Histórico de un TM compartido: amigos, el dueño o su entrenador. */
router.get('/users/:userId/training-maxes/:tmId/history', authenticateToken, async (req: Request, res: Response) => {
  try {
    const viewerId = String((req as any).user.userId);
    const targetId = String(req.params.userId);
    const tmId = String(req.params.tmId);
    if (!mongoose.isValidObjectId(targetId) || !mongoose.isValidObjectId(tmId)) {
      return res.status(400).json({ error: 'Petición inválida' });
    }

    const isSelf = viewerId === targetId;
    const friendship = isSelf ? false : await canSeeContent(viewerId, targetId);
    const target = await User.findById(targetId).select('coachId').lean();
    const iAmCoach = !!(target && String(target.coachId || '') === viewerId);
    if (!isSelf && !friendship && !iAmCoach) {
      return res.status(403).json({ error: 'Solo amigos o el entrenador pueden ver esta gráfica' });
    }

    const tm = await TrainingMax.findOne({ _id: tmId, userId: targetId }).lean();
    if (!tm) return res.status(404).json({ error: 'Marca no encontrada' });

    const snaps = await HistoryTmSnapshot.find({ trainingMaxId: tm._id }).lean();
    const entries = snaps.length
      ? await HistoryEntry.find({
          _id: { $in: snaps.map(s => s.historyEntryId) },
          userId: targetId,
        })
          .select('dateISO dateLabel createdAt')
          .lean()
      : [];
    const entryById = new Map(entries.map(e => [String(e._id), e]));
    const points: Array<{ dateISO: string; value: number }> = [];

    for (const snap of snaps) {
      const entry = entryById.get(String(snap.historyEntryId));
      const iso = entry?.dateISO || (entry?.createdAt ? new Date(entry.createdAt).toISOString().slice(0, 10) : '');
      if (!iso || iso.startsWith('1970')) continue;
      points.push({ dateISO: iso, value: snap.value });
    }

    const createdISO = tm.createdAt ? new Date(tm.createdAt).toISOString().slice(0, 10) : '';
    const today = new Date().toISOString().slice(0, 10);
    if (points.length === 0 && createdISO && createdISO !== '1970-01-01') {
      points.push({ dateISO: createdISO, value: tm.value });
    }
    points.push({ dateISO: today, value: tm.value });
    points.sort((a, b) => a.dateISO.localeCompare(b.dateISO));

    const compact: Array<{ dateISO: string; value: number }> = [];
    for (const p of points) {
      const last = compact[compact.length - 1];
      if (last && last.dateISO === p.dateISO) last.value = p.value;
      else compact.push({ ...p });
    }

    res.json({
      tm: { id: String(tm._id), name: tm.name, value: tm.value, mode: tm.mode },
      points: compact,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Perfil propio: bio, entrenador elegido y alumnos que te han marcado a ti. */
router.get('/me/profile', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const me = await User.findById(userId).select('name avatar bio coachId').lean();
    if (!me) return res.status(404).json({ error: 'Usuario no encontrado' });

    const coach = me.coachId ? await User.findById(me.coachId).select('name avatar').lean() : null;
    const athletes = await User.find({ coachId: userId }).select('name avatar').lean();

    res.json({
      id: String(me._id),
      name: me.name || 'Usuario',
      avatar: publicListAvatar(me.avatar, String(me._id)) || null,
      bio: me.bio || '',
      coach: coach ? { id: String(coach._id), name: coach.name || 'Usuario', avatar: publicListAvatar(coach.avatar, String(coach._id)) || null } : null,
      athletes: athletes.map((a: any) => ({ id: String(a._id), name: a.name || 'Usuario', avatar: publicListAvatar(a.avatar, String(a._id)) || null })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put(
  '/me/profile',
  authenticateToken,
  [body('bio').optional({ nullable: true }).isString().isLength({ max: 300 }).withMessage('Bio demasiado larga')],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const userId = (req as any).user.userId;
      const updates: Record<string, unknown> = {};
      if (req.body.bio !== undefined) updates.bio = String(req.body.bio ?? '').trim().slice(0, 300);
      const me = await User.findByIdAndUpdate(userId, updates, { new: true }).select('bio').lean();
      res.json({ bio: me?.bio || '' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/** Quitar el entrenador actual: lo decide el alumno y no necesita permiso de nadie. */
router.delete('/me/coach', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const me = await User.findById(userId).select('coachId').lean();
    if (me?.coachId) {
      await CoachRequest.deleteOne({ athlete: userId, coach: me.coachId });
    }
    await User.findByIdAndUpdate(userId, { coachId: null });
    res.json({ coach: null });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** El alumno pide «entréneme» o el entrenador invita «te entreno». No cuenta hasta que el otro acepta. */
router.post('/coach-requests', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const asCoach = !!req.body.athleteId;
    const athleteId = String(asCoach ? req.body.athleteId : me);
    const coachId = String(asCoach ? me : req.body.coachId || '');
    const initiatedBy = asCoach ? 'coach' : 'athlete';

    if (!mongoose.isValidObjectId(coachId) || !mongoose.isValidObjectId(athleteId)) {
      return res.status(400).json({ error: 'Usuario inválido' });
    }
    if (coachId === athleteId) return res.status(400).json({ error: 'No puedes ser tu propio entrenador' });

    if (!(await areFriends(athleteId, coachId))) {
      return res.status(403).json({ error: 'Primero tenéis que ser amigos' });
    }

    const [coach, athlete] = await Promise.all([
      User.findById(coachId).select('name avatar').lean(),
      User.findById(athleteId).select('name coachId').lean(),
    ]);
    if (!coach || !athlete) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (athlete.coachId && String(athlete.coachId) !== coachId) {
      return res.status(400).json({
        error: asCoach ? 'Esta persona ya tiene entrenador' : 'Ya tienes un entrenador. Déjalo antes de pedir a otro.',
      });
    }

    const existing = await CoachRequest.findOne({ athlete: athleteId, coach: coachId });
    if (existing?.status === 'accepted') {
      return res.status(400).json({ error: asCoach ? 'Ya le entrenas' : 'Ya es tu entrenador' });
    }
    if (existing) {
      existing.status = 'pending';
      existing.initiatedBy = initiatedBy;
      await existing.save();
    } else {
      await CoachRequest.create({ athlete: athleteId, coach: coachId, initiatedBy, status: 'pending' });
    }

    const notifyUser = asCoach ? athleteId : coachId;
    const fromName = asCoach ? coach.name : athlete.name;
    const coachTitle = asCoach ? 'Te quieren entrenar' : 'Te piden ser entrenador';
    const coachMessage = asCoach
      ? `${fromName || 'Alguien'} quiere ser tu entrenador`
      : `${fromName || 'Alguien'} quiere que seas su entrenador`;
    await Notification.create({
      userId: notifyUser,
      type: 'coach_request',
      title: coachTitle,
      message: coachMessage,
      relatedUserId: new mongoose.Types.ObjectId(me),
    }).catch(() => {});
    try {
      const { sendPushToUser } = await import('../utils/push');
      await sendPushToUser(String(notifyUser), coachTitle, coachMessage, {
        type: 'coach_request',
        relatedUserId: String(me),
      });
    } catch (e) {
      console.error('[PUSH] Error coach_request:', e);
    }
    broadcastSse([String(notifyUser), String(me)], 'social_update');

    res.status(201).json({ status: 'pending' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Solicitudes que te han mandado a ti (para aceptar o rechazar en Actividad). */
router.get('/coach-requests', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const [asCoach, invitedMe] = await Promise.all([
      CoachRequest.find({
        coach: userId,
        status: 'pending',
        $or: [{ initiatedBy: 'athlete' }, { initiatedBy: { $exists: false } }],
      })
        .sort({ createdAt: -1 })
        .populate('athlete', 'name avatar')
        .lean(),
      CoachRequest.find({
        athlete: userId,
        status: 'pending',
        initiatedBy: 'coach',
      })
        .sort({ createdAt: -1 })
        .populate('coach', 'name avatar')
        .lean(),
    ]);

    const fromAthlete = asCoach.map((r: any) => ({
      id: String(r._id),
      createdAt: r.createdAt,
      kind: 'they_want_me_coach' as const,
      person: {
        id: String(r.athlete?._id ?? r.athlete),
        name: r.athlete?.name || 'Usuario',
        avatar: r.athlete?.avatar || null,
      },
    }));
    const fromCoach = invitedMe.map((r: any) => ({
      id: String(r._id),
      createdAt: r.createdAt,
      kind: 'they_want_to_coach_me' as const,
      person: {
        id: String(r.coach?._id ?? r.coach),
        name: r.coach?.name || 'Usuario',
        avatar: r.coach?.avatar || null,
      },
    }));

    res.json({
      requests: [...fromAthlete, ...fromCoach].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/coach-requests/:id/:decision', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user.userId);
    const decision = req.params.decision === 'accept' ? 'accepted' : 'rejected';
    const request = await CoachRequest.findOne({ _id: req.params.id, status: 'pending' });
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });

    const startedBy = request.initiatedBy || 'athlete';
    const iAmCoach = String(request.coach) === userId;
    const iAmAthlete = String(request.athlete) === userId;
    const canDecide = (startedBy === 'athlete' && iAmCoach) || (startedBy === 'coach' && iAmAthlete);
    if (!canDecide) return res.status(404).json({ error: 'Solicitud no encontrada' });

    request.status = decision;
    await request.save();

    if (decision === 'accepted') {
      const athlete = await User.findById(request.athlete).select('coachId').lean();
      if (athlete?.coachId && String(athlete.coachId) !== String(request.coach)) {
        request.status = 'rejected';
        await request.save();
        return res.status(400).json({ error: 'Esta persona ya tiene entrenador' });
      }
      await User.findByIdAndUpdate(request.athlete, { coachId: request.coach });
      await CoachRequest.updateMany(
        { athlete: request.athlete, _id: { $ne: request._id }, status: 'pending' },
        { $set: { status: 'rejected' } }
      );
      const meUser = await User.findById(userId).select('name').lean();
      const otherId = iAmCoach ? request.athlete : request.coach;
      const acceptedTitle = 'Entrenador confirmado';
      const acceptedMessage = iAmCoach
        ? `${meUser?.name || 'Tu entrenador'} ha aceptado entrenarte`
        : `${meUser?.name || 'Alguien'} te ha aceptado como entrenador`;
      await Notification.create({
        userId: otherId,
        type: 'coach_accepted',
        title: acceptedTitle,
        message: acceptedMessage,
        relatedUserId: new mongoose.Types.ObjectId(userId),
      }).catch(() => {});
      try {
        const { sendPushToUser } = await import('../utils/push');
        await sendPushToUser(String(otherId), acceptedTitle, acceptedMessage, {
          type: 'coach_accepted',
          relatedUserId: String(userId),
        });
      } catch (e) {
        console.error('[PUSH] Error coach_accepted:', e);
      }
      broadcastSse([String(otherId), userId], 'social_update');
    }

    res.json({ status: request.status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

function authorCard(user: { _id: unknown; name?: string; avatar?: string | null }) {
  const id = String(user._id);
  return {
    id,
    name: user.name || 'Atleta',
    avatar: publicListAvatar(user.avatar, id) || null,
    online: isUserOnline(id),
  };
}

function lastPreview(
  text?: string | null,
  mediaType?: string | null,
  mediaLive?: boolean
) {
  if (mediaLive && mediaType === 'image') return (text || '').trim() || 'Foto';
  if (mediaLive && mediaType === 'video') return (text || '').trim() || 'Vídeo';
  if (mediaType && !mediaLive) return (text || '').trim() || 'Caducó';
  const raw = (text || '').trim();
  if (/^e2e/i.test(raw)) return 'Chat listo';
  return raw;
}

function chatAttachmentFields(media: { mediaKey: string; mediaType: 'image' | 'video' } | null) {
  if (!media) return { mediaKey: null as string | null, mediaType: null as 'image' | 'video' | null, mediaExpiresAt: null as Date | null };
  return {
    mediaKey: media.mediaKey,
    mediaType: media.mediaType,
    mediaExpiresAt: chatMediaExpiresAt(),
  };
}

type StoryReplySnap = {
  postId?: string;
  mediaKey?: string;
  mediaType?: string;
  caption?: string;
} | null;

type LiveStoryMedia = { mediaKey: string; mediaType: 'image' | 'video' };

function hasStoryReply(reply?: StoryReplySnap) {
  return !!(reply && (reply.postId || reply.mediaKey));
}

async function liveStoryLookup(rows: Array<{ storyReply?: StoryReplySnap }>) {
  const postIds: string[] = [];
  const mediaKeys: string[] = [];
  for (const row of rows) {
    const reply = row.storyReply;
    if (!reply) continue;
    if (reply.postId && mongoose.isValidObjectId(reply.postId)) postIds.push(reply.postId);
    if (reply.mediaKey) mediaKeys.push(reply.mediaKey);
  }
  const byKey = new Map<string, LiveStoryMedia>();
  if (postIds.length === 0 && mediaKeys.length === 0) return byKey;
  const clauses: Array<{ _id?: { $in: string[] }; mediaKey?: { $in: string[] } }> = [];
  if (postIds.length) clauses.push({ _id: { $in: [...new Set(postIds)] } });
  if (mediaKeys.length) clauses.push({ mediaKey: { $in: [...new Set(mediaKeys)] } });
  const posts = await Post.find({ $or: clauses })
    .select('_id mediaKey mediaType')
    .lean();
  for (const post of posts) {
    if (!post.mediaKey) continue;
    const media: LiveStoryMedia = {
      mediaKey: post.mediaKey,
      mediaType: post.mediaType === 'video' ? 'video' : 'image',
    };
    byKey.set(String(post._id), media);
    byKey.set(post.mediaKey, media);
  }
  return byKey;
}

function liveStoryMedia(
  reply: StoryReplySnap,
  live: Map<string, LiveStoryMedia>
): LiveStoryMedia | null {
  if (!reply) return null;
  if (reply.postId && live.has(reply.postId)) return live.get(reply.postId) || null;
  if (reply.mediaKey && live.has(reply.mediaKey)) return live.get(reply.mediaKey) || null;
  return null;
}

function serializeChatLine(
  row: {
    _id: unknown;
    from: unknown;
    text?: string;
    mediaKey?: string | null;
    mediaType?: string | null;
    mediaExpiresAt?: Date | string | null;
    createdAt: Date;
    storyReply?: StoryReplySnap;
  },
  me: string,
  author?: ReturnType<typeof authorCard>,
  liveStory?: LiveStoryMedia | null | 'snapshot'
) {
  const live = isChatMediaLive(row);
  const reply = row.storyReply;
  const showStory = hasStoryReply(reply);
  const snapshot = liveStory === 'snapshot' || liveStory === undefined;
  const fromPost = !snapshot && liveStory ? liveStory : null;
  const goneFromDb = !snapshot && !fromPost;
  const mediaKey = goneFromDb ? '' : fromPost?.mediaKey || reply?.mediaKey || '';
  return {
    id: String(row._id),
    text: row.text || '',
    storyReply: showStory
      ? {
          postId: reply?.postId || '',
          mediaKey,
          mediaType: (fromPost?.mediaType || (reply?.mediaType === 'video' ? 'video' : 'image')) as 'image' | 'video',
          caption: reply?.caption || '',
          available: !goneFromDb && !!mediaKey,
        }
      : null,
    mediaKey: live ? row.mediaKey || null : null,
    mediaType: live ? row.mediaType || null : null,
    mediaExpiresAt: live
      ? row.mediaExpiresAt
        ? new Date(row.mediaExpiresAt).toISOString()
        : chatMediaExpiresAt(row.createdAt).toISOString()
      : null,
    mediaExpired: !!(row.mediaKey && !live),
    createdAt: row.createdAt.toISOString(),
    mine: String(row.from) === me,
    author,
  };
}

async function readChatAttachment(req: Request): Promise<{ mediaKey: string; mediaType: 'image' | 'video' } | null> {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) return null;
  if (!isSupportedMediaType(file.mimetype)) {
    const err = new Error('Solo fotos (JPG, PNG, WEBP, GIF) o vídeos (MP4, MOV, WEBM)');
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
  const stored = await mediaStorage().save(file.buffer, file.mimetype);
  return { mediaKey: stored.key, mediaType: mediaKindFromMime(file.mimetype) };
}

async function canTalk(me: string, other: string): Promise<boolean> {
  if (me === other || !mongoose.isValidObjectId(other)) return false;
  if (await chatIsOpen(me, other)) return true;
  if (await follows(other, me)) return true;
  return !!(await ChatRequest.exists({
    status: { $in: ['pending', 'accepted'] },
    $or: [
      { from: me, to: other },
      { from: other, to: me },
    ],
  }));
}

/** Si le escribo a alguien que ya me sigue, abrimos el chat: no le sigo, pero sí podemos hablar. */
async function openTalkIfTheyFollowMe(me: string, other: string): Promise<void> {
  if (!(await follows(other, me))) return;
  const existing = await ChatRequest.findOne({
    $or: [
      { from: me, to: other },
      { from: other, to: me },
    ],
  });
  if (existing) {
    if (existing.status !== 'accepted') {
      existing.status = 'accepted';
      await existing.save();
    }
    return;
  }
  await ChatRequest.create({ from: me, to: other, status: 'accepted' });
}

async function notifyChatRequest(fromId: string, toId: string, preview: string) {
  const from = await User.findById(fromId).select('name email').lean();
  const name = from?.name || from?.email || 'Alguien';
  await Notification.create({
    userId: toId,
    type: 'chat_request',
    title: `${name} quiere chatear`,
    message: preview.slice(0, 80) || 'Acepta para poder hablar',
    relatedUserId: fromId,
  });
  try {
    const { sendPushToUser } = await import('../utils/push');
    await sendPushToUser(toId, `${name} quiere chatear`, 'Acepta la solicitud para hablar', {
      type: 'chat_request',
      relatedUserId: fromId,
    });
  } catch (e) {
    console.error('[PUSH] Error chat_request:', e);
  }
  broadcastSse([fromId, toId], 'social_update');
}

/** Aviso en el corazón de Inicio cuando te escriben. Si ya hay uno sin leer del mismo chat, se actualiza. */
async function notifyChatMessage(opts: {
  toIds: string[];
  fromId: string;
  preview: string;
  groupId?: string;
}) {
  const from = await User.findById(opts.fromId).select('name').lean();
  const name = from?.name || 'Alguien';
  const preview = (opts.preview || '').trim().slice(0, 80) || (opts.groupId ? 'Foto o vídeo en el grupo' : 'Te ha enviado un mensaje');
  const title = opts.groupId ? `${name} en el grupo` : `${name} te ha escrito`;
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const pushTargets: string[] = [];
  for (const toId of opts.toIds) {
    const recent = await Notification.findOne({
      userId: toId,
      type: 'chat_message',
      relatedUserId: opts.fromId,
      read: false,
      createdAt: { $gte: since },
    });
    if (recent) {
      recent.title = title;
      recent.message = preview;
      recent.relatedData = opts.groupId ? { groupId: opts.groupId, peerId: opts.fromId } : { peerId: opts.fromId };
      await recent.save().catch(() => {});
    } else {
      await Notification.create({
        userId: toId,
        type: 'chat_message',
        title,
        message: preview,
        relatedUserId: opts.fromId,
        relatedData: opts.groupId ? { groupId: opts.groupId, peerId: opts.fromId } : { peerId: opts.fromId },
      }).catch(() => {});
    }
    pushTargets.push(toId);
  }
  if (pushTargets.length) {
    try {
      const { sendPushToUsers } = await import('../utils/push');
      await sendPushToUsers(pushTargets, title, preview, {
        type: 'chat_message',
        screen: 'social',
        tab: 'chat',
        ...(opts.groupId ? { groupId: opts.groupId } : { peerId: opts.fromId }),
      });
    } catch (e) {
      console.error('[PUSH] Error chat_message:', e);
    }
  }
}

function isGroupMember(group: { members: unknown[] }, userId: string): boolean {
  return group.members.some(id => String(id) === userId);
}

async function chatHiddenAt(userId: string, kind: 'dm' | 'group', targetId: string): Promise<Date | null> {
  if (!mongoose.isValidObjectId(targetId)) return null;
  const row = await ChatHide.findOne({ user: userId, kind, targetId }).select('hiddenAt').lean();
  return row?.hiddenAt ?? null;
}

async function hideChatForMe(userId: string, kind: 'dm' | 'group', targetId: string) {
  await ChatHide.findOneAndUpdate(
    { user: userId, kind, targetId },
    { $set: { hiddenAt: new Date() } },
    { upsert: true }
  );
}

function afterHidden(hiddenAt: Date | null) {
  return hiddenAt ? { createdAt: { $gt: hiddenAt } } : {};
}

async function pendingForGroup(groupId: string) {
  const invites = await ChatGroupInvite.find({ groupId, status: 'pending' }).select('to').lean();
  if (invites.length === 0) return [];
  const users = await User.find({ _id: { $in: invites.map(i => i.to) } }).select('name avatar').lean();
  return users.map(authorCard);
}

/** Solo invitación al grupo. No se manda también una solicitud de amistad. */
async function inviteToGroup(opts: {
  groupId: mongoose.Types.ObjectId;
  groupName: string;
  fromId: string;
  inviteeIds: string[];
  kind?: 'group' | 'team';
}) {
  if (opts.inviteeIds.length === 0) return;
  const from = await User.findById(opts.fromId).select('name').lean();
  const creatorName = from?.name || 'Alguien';
  const acceptMsg = opts.kind === 'team' ? 'Acepta para entrar al equipo' : 'Acepta para entrar al grupo';
  for (const invitee of opts.inviteeIds) {
    await ChatGroupInvite.findOneAndUpdate(
      { groupId: opts.groupId, to: invitee },
      { from: opts.fromId, status: 'pending' },
      { upsert: true, new: true }
    );
    await Notification.create({
      userId: invitee,
      type: 'group_invite',
      title: `${creatorName} te invita a «${opts.groupName}»`,
      message: acceptMsg,
      relatedUserId: opts.fromId,
      relatedData: { groupId: String(opts.groupId) },
    }).catch(() => {});
    try {
      const { sendPushToUser } = await import('../utils/push');
      await sendPushToUser(invitee, `${creatorName} te invita a «${opts.groupName}»`, acceptMsg, {
        type: 'group_invite',
        groupId: String(opts.groupId),
      });
    } catch (e) {
      console.error('[PUSH] Error group_invite:', e);
    }
  }
  broadcastSse(opts.inviteeIds, 'social_update');
}

async function splitJoinAndInvite(me: string, personIds: string[]) {
  const friends: string[] = [];
  const invitees: string[] = [];
  for (const id of personIds) {
    if (await canTalk(me, id)) friends.push(id);
    else invitees.push(id);
  }
  return { friends, invitees };
}

async function serializeGroupCard(group: {
  _id: unknown;
  name: string;
  createdBy: unknown;
  members: unknown[];
  kind?: string;
}) {
  const users = await User.find({ _id: { $in: group.members } }).select('name avatar').lean();
  return {
    id: String(group._id),
    name: group.name,
    createdBy: String(group.createdBy),
    kind: group.kind === 'team' ? 'team' : 'group',
    members: users.map(authorCard),
    pending: await pendingForGroup(String(group._id)),
  };
}

/** Lista de conversaciones: DMs + grupos. El entrenador va siempre primero. */
router.get('/chats', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const meOid = new mongoose.Types.ObjectId(me);
    const meDoc = await User.findById(me).select('coachId').lean();
    const coachId = meDoc?.coachId ? String(meDoc.coachId) : null;
    const hides = await ChatHide.find({ user: me }).select('kind targetId hiddenAt').lean();
    const hideDm = new Map(
      hides.filter(h => h.kind === 'dm').map(h => [String(h.targetId), h.hiddenAt])
    );
    const hideGroup = new Map(
      hides.filter(h => h.kind === 'group').map(h => [String(h.targetId), h.hiddenAt])
    );

    const rows = await ChatMessage.find({
      groupId: null,
      $or: [{ from: me }, { to: me }],
    })
      .sort({ createdAt: -1 })
      .limit(400)
      .lean();

    const seen = new Set<string>();
    const dmThreads: Array<{ peerId: string; lastText: string; lastAt: string; unread: number }> = [];
    for (const row of rows) {
      if (!row.to) continue;
      const peerId = String(row.from) === me ? String(row.to) : String(row.from);
      if (seen.has(peerId)) continue;
      const hiddenAt = hideDm.get(peerId);
      if (hiddenAt && row.createdAt <= hiddenAt) {
        seen.add(peerId);
        continue;
      }
      seen.add(peerId);
      dmThreads.push({
        peerId,
        lastText: hasStoryReply(row.storyReply)
          ? (row.text ? `Historia · ${row.text}` : 'Respondió a tu historia')
          : lastPreview(row.text, row.mediaType, isChatMediaLive(row)),
        lastAt: row.createdAt.toISOString(),
        unread: 0,
      });
    }

    const unreadRows = await ChatMessage.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      { $match: { groupId: null, to: meOid, readAt: null } },
      { $group: { _id: '$from', n: { $sum: 1 } } },
    ]);
    const unreadMap = new Map(unreadRows.map(r => [String(r._id), r.n]));
    for (const thread of dmThreads) thread.unread = unreadMap.get(thread.peerId) ?? 0;

    const groups = await ChatGroup.find({ members: meOid }).lean();
    const groupIds = groups.map(g => g._id);
    const [groupLast, groupUnread] = groupIds.length
      ? await Promise.all([
          ChatMessage.aggregate<{
            _id: mongoose.Types.ObjectId;
            text: string;
            mediaType?: string | null;
            mediaKey?: string | null;
            mediaExpiresAt?: Date | null;
            createdAt: Date;
          }>([
            { $match: { groupId: { $in: groupIds } } },
            { $sort: { createdAt: -1 } },
            {
              $group: {
                _id: '$groupId',
                text: { $first: '$text' },
                mediaType: { $first: '$mediaType' },
                mediaKey: { $first: '$mediaKey' },
                mediaExpiresAt: { $first: '$mediaExpiresAt' },
                createdAt: { $first: '$createdAt' },
              },
            },
          ]),
          ChatMessage.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
            { $match: { groupId: { $in: groupIds }, from: { $ne: meOid }, readBy: { $nin: [meOid] } } },
            { $group: { _id: '$groupId', n: { $sum: 1 } } },
          ]),
        ])
      : [[], []];
    const lastByGroup = new Map(groupLast.map(r => [String(r._id), r]));
    const unreadByGroup = new Map(groupUnread.map(r => [String(r._id), r.n]));

    const outgoingChat = await ChatRequest.find({ from: me, status: 'pending' }).lean();
    const incomingChat = await ChatRequest.find({ to: me, status: 'pending' }).lean();
    const incomingIds = new Set(incomingChat.map(r => String(r.from)));
    const peopleIds = [
      ...dmThreads.map(t => t.peerId),
      ...(coachId ? [coachId] : []),
      ...outgoingChat.map(r => String(r.to)),
      ...incomingChat.map(r => String(r.from)),
      ...groups.flatMap(g => g.members.map(id => String(id))),
    ];
    const users = await User.find({ _id: { $in: [...new Set(peopleIds)] } })
      .select('name avatar')
      .lean();
    const byId = new Map(users.map(u => [String(u._id), u]));

    const threads: Array<Record<string, unknown>> = [];

    for (const thread of dmThreads) {
      const user = byId.get(thread.peerId);
      if (!user) continue;
      threads.push({
        kind: 'dm',
        peer: authorCard(user),
        lastText: thread.lastText,
        lastAt: thread.lastAt,
        unread: thread.unread,
        isCoach: coachId === thread.peerId,
        incoming: incomingIds.has(thread.peerId),
      });
    }

    if (coachId && !threads.some(t => t.kind === 'dm' && (t.peer as { id: string }).id === coachId)) {
      const coach = byId.get(coachId);
      if (coach) {
        threads.push({
          kind: 'dm',
          peer: authorCard(coach),
          lastText: 'Habla de la sesión, las marcas o el plan',
          lastAt: '',
          unread: 0,
          isCoach: true,
        });
      }
    }

    for (const req of incomingChat) {
      const peerId = String(req.from);
      if (threads.some(t => t.kind === 'dm' && (t.peer as { id: string }).id === peerId)) continue;
      const hiddenAt = hideDm.get(peerId);
      if (hiddenAt && req.updatedAt <= hiddenAt) continue;
      const user = byId.get(peerId);
      if (!user) continue;
      threads.push({
        kind: 'dm',
        peer: authorCard(user),
        lastText: req.preview || 'Quiere chatear',
        lastAt: req.updatedAt.toISOString(),
        unread: 1,
        isCoach: false,
        incoming: true,
      });
    }

    for (const req of outgoingChat) {
      const peerId = String(req.to);
      if (threads.some(t => t.kind === 'dm' && (t.peer as { id: string }).id === peerId)) continue;
      const hiddenAt = hideDm.get(peerId);
      if (hiddenAt && req.updatedAt <= hiddenAt) continue;
      const user = byId.get(peerId);
      if (!user) continue;
      threads.push({
        kind: 'dm',
        peer: authorCard(user),
        lastText: req.preview || 'Esperando a que acepte',
        lastAt: req.updatedAt.toISOString(),
        unread: 0,
        isCoach: false,
        waiting: true,
      });
    }

    for (const group of groups) {
      const last = lastByGroup.get(String(group._id));
      const lastAt = last?.createdAt ?? group.createdAt;
      const hiddenAt = hideGroup.get(String(group._id));
      if (hiddenAt && lastAt <= hiddenAt) continue;
      threads.push({
        kind: 'group',
        group: {
          id: String(group._id),
          name: group.name,
          createdBy: String(group.createdBy),
          kind: group.kind === 'team' ? 'team' : 'group',
          members: group.members
            .map(id => byId.get(String(id)))
            .filter(Boolean)
            .map(u => authorCard(u!)),
          pending: await pendingForGroup(String(group._id)),
        },
        lastText: last
          ? lastPreview(last.text, last.mediaType, isChatMediaLive(last))
          : group.kind === 'team'
            ? 'Equipo nuevo'
            : 'Grupo nuevo',
        lastAt: last?.createdAt ? last.createdAt.toISOString() : group.createdAt.toISOString(),
        unread: unreadByGroup.get(String(group._id)) ?? 0,
        isCoach: false,
      });
    }

    threads.sort((a, b) => {
      if (a.isCoach && !b.isCoach) return -1;
      if (!a.isCoach && b.isCoach) return 1;
      return String(b.lastAt || '').localeCompare(String(a.lastAt || ''));
    });

    res.json({ threads });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/chats/groups', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const name = String(req.body?.name || '').trim().slice(0, 40);
    const kind = req.body?.kind === 'team' ? 'team' : 'group';
    const noun = kind === 'team' ? 'equipo' : 'grupo';
    const rawIds: string[] = Array.isArray(req.body?.memberIds)
      ? (req.body.memberIds as unknown[]).map(id => String(id))
      : [];
    if (!name) return res.status(400).json({ error: `Ponle un nombre al ${noun}` });

    const unique = [...new Set(rawIds.filter(id => id && id !== me))];
    if (unique.length < 1) return res.status(400).json({ error: 'Elige al menos a una persona' });
    if (unique.length > 29) return res.status(400).json({ error: `Máximo 30 personas en un ${noun}` });

    const people = await User.find({ _id: { $in: unique } }).select('_id name').lean();
    if (people.length < 1) return res.status(400).json({ error: 'No se ha encontrado a nadie' });

    const { friends, invitees } = await splitJoinAndInvite(me, people.map(p => String(p._id)));
    const members = [me, ...friends];
    const group = await ChatGroup.create({ name, createdBy: me, members, kind });
    await inviteToGroup({ groupId: group._id, groupName: name, fromId: me, inviteeIds: invitees, kind });
    const card = await serializeGroupCard(group);

    res.status(201).json({
      kind: 'group',
      group: card,
      lastText: card.pending?.length ? 'Esperando a que acepten' : kind === 'team' ? 'Equipo nuevo' : 'Grupo nuevo',
      lastAt: group.createdAt.toISOString(),
      unread: 0,
      isCoach: false,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/chats/groups/:groupId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const groupId = String(req.params.groupId);
    const name = String(req.body?.name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'Ponle un nombre al grupo' });
    if (!mongoose.isValidObjectId(groupId)) return res.status(400).json({ error: 'Grupo inválido' });
    const group = await ChatGroup.findById(groupId);
    if (!group || !isGroupMember(group, me)) return res.status(404).json({ error: 'Grupo no encontrado' });
    group.name = name;
    await group.save();
    broadcastSse(group.members.map(id => String(id)), 'social_update');
    res.json({ group: await serializeGroupCard(group) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/chats/groups/:groupId/members', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const groupId = String(req.params.groupId);
    const rawIds: string[] = Array.isArray(req.body?.memberIds)
      ? (req.body.memberIds as unknown[]).map(id => String(id))
      : [];
    if (!mongoose.isValidObjectId(groupId)) return res.status(400).json({ error: 'Grupo inválido' });
    const group = await ChatGroup.findById(groupId);
    if (!group || !isGroupMember(group, me)) return res.status(404).json({ error: 'Grupo no encontrado' });

    const already = new Set(group.members.map(id => String(id)));
    const unique = [...new Set(rawIds.filter(id => id && id !== me && mongoose.isValidObjectId(id) && !already.has(id)))];
    if (unique.length < 1) return res.status(400).json({ error: 'Elige a alguien que no esté ya' });
    if (already.size + unique.length > 30) return res.status(400).json({ error: 'Máximo 30 personas en un grupo' });

    const people = await User.find({ _id: { $in: unique } }).select('_id').lean();
    const { friends, invitees } = await splitJoinAndInvite(me, people.map(p => String(p._id)));
    if (friends.length) {
      await ChatGroup.updateOne({ _id: group._id }, { $addToSet: { members: { $each: friends } } });
    }
    await inviteToGroup({
      groupId: group._id,
      groupName: group.name,
      fromId: me,
      inviteeIds: invitees,
      kind: group.kind === 'team' ? 'team' : 'group',
    });
    const fresh = await ChatGroup.findById(group._id);
    if (!fresh) return res.status(404).json({ error: 'Grupo no encontrado' });
    broadcastSse([...fresh.members.map(id => String(id)), ...invitees], 'social_update');
    res.json({ group: await serializeGroupCard(fresh) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/chats/groups/:groupId/members/:userId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const groupId = String(req.params.groupId);
    const targetId = String(req.params.userId);
    if (!mongoose.isValidObjectId(groupId) || !mongoose.isValidObjectId(targetId)) {
      return res.status(400).json({ error: 'Grupo inválido' });
    }
    const group = await ChatGroup.findById(groupId);
    if (!group || !isGroupMember(group, me)) return res.status(404).json({ error: 'Grupo no encontrado' });

    const leaving = targetId === me;
    const creator = String(group.createdBy) === me;
    if (!leaving && !creator) return res.status(403).json({ error: 'Solo quien creó el grupo puede echar a alguien' });
    if (!isGroupMember(group, targetId)) return res.status(404).json({ error: 'Esa persona no está en el grupo' });

    const notify = group.members.map(id => String(id));
    await ChatGroup.updateOne({ _id: group._id }, { $pull: { members: targetId } });
    const leftover = await ChatGroup.findById(group._id);
    if (leftover && leftover.members.length === 0) {
      await ChatGroup.deleteOne({ _id: group._id });
      await ChatMessage.deleteMany({ groupId: group._id });
      await ChatGroupInvite.deleteMany({ groupId: group._id });
    }
    broadcastSse(notify, 'social_update');
    res.json({ ok: true, left: leaving });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/chats/groups/:groupId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const groupId = String(req.params.groupId);
    if (!mongoose.isValidObjectId(groupId)) return res.status(400).json({ error: 'Grupo inválido' });
    const group = await ChatGroup.findById(groupId);
    if (!group || !isGroupMember(group, me)) return res.status(404).json({ error: 'Grupo no encontrado' });
    await hideChatForMe(me, 'group', groupId);
    const notify = group.members.map(id => String(id));
    await ChatGroup.updateOne({ _id: group._id }, { $pull: { members: me } });
    const leftover = await ChatGroup.findById(group._id);
    if (leftover && leftover.members.length === 0) {
      await ChatGroup.deleteOne({ _id: group._id });
      await ChatMessage.deleteMany({ groupId: group._id });
      await ChatGroupInvite.deleteMany({ groupId: group._id });
    }
    broadcastSse(notify, 'social_update');
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/chats/group-invites', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const rows = await ChatGroupInvite.find({ to: me, status: 'pending' }).sort({ createdAt: -1 }).lean();
    const groups = await ChatGroup.find({ _id: { $in: rows.map(r => r.groupId) } }).select('name kind').lean();
    const froms = await User.find({ _id: { $in: rows.map(r => r.from) } }).select('name avatar').lean();
    const groupById = new Map(groups.map(g => [String(g._id), g]));
    const fromById = new Map(froms.map(u => [String(u._id), u]));

    res.json({
      invites: rows
        .map(row => {
          const group = groupById.get(String(row.groupId));
          const from = fromById.get(String(row.from));
          if (!group || !from) return null;
          return {
            id: String(row._id),
            groupId: String(row.groupId),
            groupName: group.name,
            kind: group.kind === 'team' ? 'team' : 'group',
            from: authorCard(from),
            createdAt: row.createdAt.toISOString(),
          };
        })
        .filter(Boolean),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/chats/group-invites/:id/accept', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const invite = await ChatGroupInvite.findOne({ _id: req.params.id, to: me, status: 'pending' });
    if (!invite) return res.status(404).json({ error: 'Solicitud no encontrada' });
    const group = await ChatGroup.findById(invite.groupId);
    if (!group) return res.status(404).json({ error: 'El grupo ya no existe' });

    invite.status = 'accepted';
    await invite.save();
    await ChatGroup.updateOne({ _id: group._id }, { $addToSet: { members: me } });
    broadcastSse([me, String(invite.from), ...group.members.map(id => String(id))], 'social_update');
    res.json({ ok: true, groupId: String(group._id) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/chats/group-invites/:id/reject', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const invite = await ChatGroupInvite.findOneAndUpdate(
      { _id: req.params.id, to: me, status: 'pending' },
      { status: 'rejected' },
      { new: true }
    );
    if (!invite) return res.status(404).json({ error: 'Solicitud no encontrada' });
    broadcastSse([me, String(invite.from)], 'social_update');
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/chats/groups/:groupId/messages', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const groupId = String(req.params.groupId);
    if (!mongoose.isValidObjectId(groupId)) return res.status(400).json({ error: 'Grupo inválido' });
    const group = await ChatGroup.findById(groupId).lean();
    if (!group || !isGroupMember(group, me)) return res.status(404).json({ error: 'Grupo no encontrado' });

    const hiddenAt = await chatHiddenAt(me, 'group', groupId);
    const rows = await ChatMessage.find({ groupId, ...afterHidden(hiddenAt) })
      .sort({ createdAt: 1 })
      .limit(200)
      .lean();
    const authors = await User.find({ _id: { $in: rows.map(r => r.from) } }).select('name avatar').lean();
    const byId = new Map(authors.map(u => [String(u._id), u]));

    await ChatMessage.updateMany(
      { groupId, from: { $ne: me }, readBy: { $ne: me } },
      { $addToSet: { readBy: me } }
    );

    const liveStories = await liveStoryLookup(rows);
    res.json({
      group: await serializeGroupCard(group),
      messages: rows.map(row => {
        const author = byId.get(String(row.from));
        return serializeChatLine(
          row,
          me,
          author ? authorCard(author) : { id: String(row.from), name: 'Atleta', avatar: null, online: false },
          liveStoryMedia(row.storyReply ?? null, liveStories)
        );
      }),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/chats/groups/:groupId/messages', authenticateToken, optionalChatFile, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const groupId = String(req.params.groupId);
    const text = String(req.body?.text || '').trim().slice(0, 2000);
    let media: { mediaKey: string; mediaType: 'image' | 'video' } | null = null;
    try {
      media = await readChatAttachment(req);
    } catch (e: any) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    if (!text && !media) return res.status(400).json({ error: 'Escribe un mensaje o adjunta una foto' });
    if (!mongoose.isValidObjectId(groupId)) return res.status(400).json({ error: 'Grupo inválido' });
    const group = await ChatGroup.findById(groupId).lean();
    if (!group || !isGroupMember(group, me)) return res.status(404).json({ error: 'Grupo no encontrado' });

    const meUser = await User.findById(me).select('name avatar').lean();
    const created = await ChatMessage.create({
      from: me,
      groupId,
      text,
      ...chatAttachmentFields(media),
      readBy: [me],
    });
    const line = serializeChatLine(created, me, meUser ? authorCard(meUser) : { id: me, name: 'Tú', avatar: null, online: true });
    const others = group.members.map(id => String(id)).filter(id => id !== me);
    broadcastSse(others, 'chat_message', { message: { ...line, mine: false }, groupId });
    void notifyChatMessage({ toIds: others, fromId: me, preview: text, groupId });
    res.status(201).json(line);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/chats/chat-requests', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const rows = await ChatRequest.find({ to: me, status: 'pending' }).sort({ createdAt: -1 }).lean();
    const froms = await User.find({ _id: { $in: rows.map(r => r.from) } }).select('name avatar').lean();
    const byId = new Map(froms.map(u => [String(u._id), u]));
    res.json({
      requests: rows
        .map(row => {
          const from = byId.get(String(row.from));
          if (!from) return null;
          return {
            id: String(row._id),
            from: authorCard(from),
            preview: row.preview || '',
            createdAt: row.createdAt.toISOString(),
          };
        })
        .filter(Boolean),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/chats/chat-requests/:id/accept', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const request = await ChatRequest.findOne({ _id: req.params.id, to: me, status: 'pending' });
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });
    request.status = 'accepted';
    await request.save();
    const already = await ChatMessage.exists({
      groupId: null,
      from: request.from,
      to: me,
      text: request.preview || '',
    });
    if (request.preview && !already) {
      await ChatMessage.create({ from: request.from, to: me, text: request.preview });
    }
    broadcastSse([me, String(request.from)], 'social_update');
    res.json({ ok: true, peerId: String(request.from) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/chats/chat-requests/:id/reject', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const request = await ChatRequest.findOne({ _id: req.params.id, to: me, status: 'pending' });
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });
    const fromId = String(request.from);
    await wipeDmBothSides(me, fromId);
    broadcastSse([me, fromId], 'social_update');
    res.json({ ok: true, peerId: fromId, rejected: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/chats/:peerId/read', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const peerId = String(req.params.peerId);
    if (!mongoose.isValidObjectId(peerId) || peerId === me) {
      return res.status(400).json({ error: 'Chat inválido' });
    }
    await ChatMessage.updateMany(
      { groupId: null, from: peerId, to: me, readAt: null },
      { $set: { readAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/chats/groups/:groupId/read', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const groupId = String(req.params.groupId);
    if (!mongoose.isValidObjectId(groupId)) return res.status(400).json({ error: 'Grupo inválido' });
    const group = await ChatGroup.findById(groupId).lean();
    if (!group || !isGroupMember(group, me)) return res.status(404).json({ error: 'Grupo no encontrado' });
    await ChatMessage.updateMany(
      { groupId, from: { $ne: me }, readBy: { $ne: me } },
      { $addToSet: { readBy: me } }
    );
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/chats/:peerId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const peerId = String(req.params.peerId);
    if (!mongoose.isValidObjectId(peerId) || peerId === me) {
      return res.status(400).json({ error: 'Chat inválido' });
    }
    await hideChatForMe(me, 'dm', peerId);
    await ChatMessage.updateMany(
      { groupId: null, from: peerId, to: me, readAt: null },
      { $set: { readAt: new Date() } }
    );
    await ChatRequest.deleteOne({ from: me, to: peerId, status: 'pending' });
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

async function loadDmLines(me: string, peerId: string) {
  const hiddenAt = await chatHiddenAt(me, 'dm', peerId);
  const rows = await ChatMessage.find({
    groupId: null,
    $or: [
      { from: me, to: peerId },
      { from: peerId, to: me },
    ],
    ...afterHidden(hiddenAt),
  })
    .sort({ createdAt: 1 })
    .limit(200)
    .lean();
  const liveStories = await liveStoryLookup(rows);
  return rows.map(row =>
    serializeChatLine(row, me, undefined, liveStoryMedia(row.storyReply ?? null, liveStories))
  );
}

router.get('/chats/:peerId/messages', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const peerId = String(req.params.peerId);
    const outgoing = await ChatRequest.findOne({ from: me, to: peerId, status: 'pending' }).lean();
    const incoming = await ChatRequest.findOne({ from: peerId, to: me, status: 'pending' }).lean();
    const messages = await loadDmLines(me, peerId);
    const online = isUserOnline(peerId);

    await ChatMessage.updateMany(
      { groupId: null, from: peerId, to: me, readAt: null },
      { $set: { readAt: new Date() } }
    );

    if (outgoing) {
      return res.json({
        waiting: true,
        incoming: false,
        preview: outgoing.preview || '',
        requestId: String(outgoing._id),
        online,
        messages: messages.length
          ? messages
          : outgoing.preview
            ? [{ id: 'preview', text: outgoing.preview, createdAt: outgoing.createdAt.toISOString(), mine: true }]
            : [],
      });
    }

    if (incoming || (!(await chatIsOpen(me, peerId)) && messages.some(m => !m.mine))) {
      const request = incoming || (await ensurePendingChatRequest(peerId, me, messages.find(m => !m.mine)?.text || ''));
      return res.json({
        waiting: false,
        incoming: true,
        requestId: request ? String(request._id) : undefined,
        online,
        messages,
      });
    }

    if (await chatIsOpen(me, peerId)) {
      return res.json({
        waiting: false,
        incoming: false,
        online,
        messages,
      });
    }

    return res.json({ waiting: false, locked: true, incoming: false, messages: [] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/chats/typing', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const peerId = req.body?.peerId ? String(req.body.peerId) : '';
    const groupId = req.body?.groupId ? String(req.body.groupId) : '';
    const meUser = await User.findById(me).select('name').lean();
    const fromName = meUser?.name || 'Alguien';
    if (peerId && mongoose.isValidObjectId(peerId) && (await canTalk(me, peerId))) {
      broadcastSse([peerId], 'chat_typing', { fromId: me, fromName, peerId: me });
      return res.json({ ok: true });
    }
    if (groupId && mongoose.isValidObjectId(groupId)) {
      const group = await ChatGroup.findById(groupId).lean();
      if (group && isGroupMember(group, me)) {
        broadcastSse(
          group.members.map(id => String(id)).filter(id => id !== me),
          'chat_typing',
          { fromId: me, fromName, groupId }
        );
      }
    }
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/chats/:peerId/messages', authenticateToken, optionalChatFile, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const peerId = String(req.params.peerId);
    const text = String(req.body?.text || '').trim().slice(0, 2000);
    let media: { mediaKey: string; mediaType: 'image' | 'video' } | null = null;
    try {
      media = await readChatAttachment(req);
    } catch (e: any) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    if (!text && !media) return res.status(400).json({ error: 'Escribe un mensaje o adjunta una foto' });
    if (!mongoose.isValidObjectId(peerId) || me === peerId) {
      return res.status(400).json({ error: 'Destinatario inválido' });
    }
    const peer = await User.findById(peerId).select('_id').lean();
    if (!peer) return res.status(404).json({ error: 'Usuario no encontrado' });

    const deliver = async (created: { _id: unknown; from: unknown; text?: string; mediaKey?: string | null; mediaType?: string | null; createdAt: Date }) => {
      const line = serializeChatLine(created, me);
      broadcastSse([peerId], 'chat_message', { message: { ...line, mine: false }, peerId: me });
      void notifyChatMessage({ toIds: [peerId], fromId: me, preview: text });
      return line;
    };

    if (await canTalk(me, peerId)) {
      await openTalkIfTheyFollowMe(me, peerId);
      const created = await ChatMessage.create({
        from: me,
        to: peerId,
        text,
        ...chatAttachmentFields(media),
      });
      if (!(await chatIsOpen(peerId, me))) {
        await ensurePendingChatRequest(me, peerId, text);
      }
      return res.status(201).json(await deliver(created));
    }

    const incoming = await ChatRequest.findOne({ from: peerId, to: me, status: 'pending' });
    if (incoming) {
      incoming.status = 'accepted';
      await incoming.save();
      if (incoming.preview) {
        await ChatMessage.create({ from: peerId, to: me, text: incoming.preview });
      }
      const created = await ChatMessage.create({
        from: me,
        to: peerId,
        text,
        ...chatAttachmentFields(media),
      });
      broadcastSse([me, peerId], 'social_update');
      return res.status(201).json(await deliver(created));
    }

    const existing = await ChatRequest.findOne({ from: me, to: peerId });
    if (existing?.status === 'accepted') {
      const created = await ChatMessage.create({
        from: me,
        to: peerId,
        text,
        ...chatAttachmentFields(media),
      });
      return res.status(201).json(await deliver(created));
    }
    if (media) {
      return res.status(400).json({ error: 'Hasta que acepte no puedes enviar fotos ni vídeos' });
    }
    if (existing?.status === 'rejected') {
      existing.status = 'pending';
      existing.preview = text.slice(0, 2000);
      await existing.save();
      await notifyChatRequest(me, peerId, text);
      return res.status(202).json({
        requested: true,
        waiting: true,
        id: 'preview',
        text: existing.preview,
        createdAt: existing.updatedAt.toISOString(),
        mine: true,
      });
    }
    if (existing?.status === 'pending') {
      existing.preview = text.slice(0, 2000);
      await existing.save();
      return res.status(202).json({
        requested: true,
        waiting: true,
        id: 'preview',
        text: existing.preview,
        createdAt: existing.updatedAt.toISOString(),
        mine: true,
      });
    }

    const createdReq = await ChatRequest.create({
      from: me,
      to: peerId,
      status: 'pending',
      preview: text.slice(0, 2000),
    });
    await notifyChatRequest(me, peerId, text);
    res.status(202).json({
      requested: true,
      waiting: true,
      id: 'preview',
      text: createdReq.preview,
      createdAt: createdReq.createdAt.toISOString(),
      mine: true,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
