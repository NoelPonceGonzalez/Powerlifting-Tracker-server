import express, { Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { Notification } from '../models/Notification';
import { User } from '../models/User';
import { Friendship } from '../models/Friendship';
import { body, validationResult } from 'express-validator';
import { sendPushToUser } from '../utils/push';

const router = express.Router();

// PUT /api/notifications/push-token - Registrar token de push (Expo)
router.put(
  '/push-token',
  authenticateToken,
  [body('token').trim().notEmpty().withMessage('El token es requerido')],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const userId = (req as any).userId || (req as any).user?.userId;
      if (!userId) return res.status(401).json({ error: 'Usuario no autenticado' });
      const { token } = req.body;
      await User.findByIdAndUpdate(userId, { pushToken: token });
      res.json({ message: 'Token registrado' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// POST /api/notifications/same-time - Notificar a un amigo que irás a la misma hora
router.post(
  '/same-time',
  authenticateToken,
  [
    body('friendUserId').isString().notEmpty().withMessage('friendUserId requerido'),
    body('gymName').trim().notEmpty().withMessage('gymName requerido'),
    body('time').matches(/^\d{2}:\d{2}$/).withMessage('time debe tener formato HH:MM'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const fromUserId = (req as any).user?.userId || (req as any).userId;
      const fromUserName = (req as any).user?.name || (req as any).user?.email || 'Un amigo';
      const { friendUserId, gymName, time } = req.body;

      // Verificar amistad aceptada para evitar spam.
      const friendship = await Friendship.findOne({
        $or: [
          { requester: fromUserId, recipient: friendUserId, status: 'accepted' },
          { requester: friendUserId, recipient: fromUserId, status: 'accepted' },
        ],
      });

      if (!friendship) {
        return res.status(403).json({ error: 'Solo puedes notificar a amigos aceptados' });
      }

      const notification = new Notification({
        userId: friendUserId,
        type: 'gym_checkin',
        title: `${fromUserName} se apunta a tu entrenamiento`,
        message: `${gymName} a las ${time}`,
        relatedUserId: fromUserId,
        relatedData: {
          gymName,
          time,
          kind: 'same_time_confirmation',
        },
      });

      await notification.save();

      // Push al móvil (llega aunque la app esté cerrada)
      try {
        await sendPushToUser(
          String(friendUserId),
          `${fromUserName} se apunta a tu entrenamiento`,
          `${gymName} a las ${time}`,
          {
            type: 'gym_checkin',
            relatedUserId: String(fromUserId),
            gymName,
            time,
            kind: 'same_time_confirmation',
          }
        );
      } catch (e) {
        console.error('[PUSH] Error same-time:', e);
      }
      res.status(201).json({ message: 'Notificación enviada' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// GET /api/notifications - Obtener notificaciones del usuario
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const limit = parseInt(req.query.limit as string) || 50;
    const unreadOnly = req.query.unread === 'true';

    const query: any = { userId };
    if (unreadOnly) {
      query.read = false;
    }

    const notifications = await Notification.find(query)
      .populate('relatedUserId', 'name email avatar')
      .sort({ createdAt: -1 })
      .limit(limit);

    const formatted = notifications.map(n => ({
      id: n._id.toString(),
      type: n.type,
      title: n.title,
      message: n.message,
      relatedUserId: n.relatedUserId ? (n.relatedUserId as any)._id.toString() : null,
      relatedUser: n.relatedUserId ? {
        name: (n.relatedUserId as any).name || (n.relatedUserId as any).email,
        avatar: (n.relatedUserId as any).avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent((n.relatedUserId as any).name || (n.relatedUserId as any).email)}`,
      } : null,
      relatedData: n.relatedData,
      read: n.read,
      createdAt: n.createdAt,
    }));

    res.json(formatted);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/notifications/:id/read - Marcar notificación como leída
router.put('/:id/read', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId },
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ error: 'Notificación no encontrada' });
    }

    res.json({ message: 'Notificación marcada como leída' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/notifications/read-all - Marcar todas las notificaciones como leídas
router.put('/read-all', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || (req as any).user?.userId;
    await Notification.updateMany({ userId, read: false }, { read: true });
    res.json({ message: 'Todas las notificaciones marcadas como leídas' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/notifications/unread-count - Obtener contador de no leídas
router.get('/unread-count', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const count = await Notification.countDocuments({ userId, read: false });
    res.json({ count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
