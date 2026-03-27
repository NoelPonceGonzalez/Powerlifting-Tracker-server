import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth';
import { User } from '../models/User';
import { Friendship } from '../models/Friendship';
import { Notification } from '../models/Notification';
import { Routine } from '../models/Routine';
import { TrainingMax } from '../models/TrainingMax';
import { body, validationResult } from 'express-validator';
import { assembleFullRoutine } from '../utils/assembleRoutine';

const router = express.Router();

// GET /api/social/search - Buscar usuarios por nombre
router.get(
  '/search',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.userId;
      const query = req.query.q as string;

      if (!query || query.trim().length < 2) {
        return res.json([]);
      }

      // Buscar usuarios por nombre, email o username (excluyendo al usuario actual)
      const users = await User.find({
        _id: { $ne: userId },
        emailVerified: true,
        $or: [
          { name: { $regex: query, $options: 'i' } },
          { email: { $regex: query, $options: 'i' } },
          ...(query.length >= 2 ? [{ username: { $regex: query, $options: 'i' } }] : []),
        ],
      })
        .select('name email username avatar bodyWeight')
        .limit(20);

      // Obtener el estado de amistad para cada usuario
      const userIds = users.map(u => u._id);
      const friendships = await Friendship.find({
        $or: [
          { requester: userId, recipient: { $in: userIds } },
          { requester: { $in: userIds }, recipient: userId },
        ],
      });

      const friendshipMap = new Map();
      friendships.forEach(f => {
        const otherUserId = f.requester.toString() === userId ? f.recipient.toString() : f.requester.toString();
        friendshipMap.set(otherUserId, f.status);
      });

      const results = users.map(user => ({
        id: user._id.toString(),
        name: user.name || (user as any).username || user.email,
        email: user.email,
        username: (user as any).username,
        avatar: user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name || (user as any).username || user.email)}`,
        bodyWeight: user.bodyWeight,
        friendshipStatus: friendshipMap.get(user._id.toString()) || null,
      }));

      res.json(results);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

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
    const routine = await Routine.findOne({ userId: friendObjectId, isActive: true });
    if (!routine || (routine as any).hiddenFromSocial) {
      return res.json(null);
    }

    const assembled = (await assembleFullRoutine(routine)) as Record<string, unknown>;

    res.json({
      id: String(assembled._id ?? assembled.id ?? ''),
      name: assembled.name,
      weeks: assembled.weeks,
      baseTemplate: assembled.baseTemplate,
      versions: assembled.versions,
      logs: assembled.logs,
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
    const tms = activeRoutine?._id
      ? await TrainingMax.find({
          userId: friendId,
          routineId: activeRoutine._id,
          sharedToSocial: true,
        })
          .select('name value mode')
          .sort({ createdAt: 1 })
          .lean()
      : [];

    res.json({
      name: friend.name || 'Usuario',
      avatar: friend.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(friend.name || 'U')}`,
      trainingMaxes: tms.map((t: any) => ({ name: t.name, value: t.value, mode: t.mode })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/social/friends - Obtener lista de amigos (siempre el OTRO usuario, nunca el actual)
router.get('/friends', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user.userId);

    const friendships = await Friendship.find({
      $or: [{ requester: userId }, { recipient: userId }],
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
    const userId = (req as any).user.userId;

    const requests = await Friendship.find({
      recipient: userId,
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

    res.json({ message: 'Amistad eliminada' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
