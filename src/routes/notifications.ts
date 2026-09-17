import express, { Request, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { Notification } from '../models/Notification';
import { User } from '../models/User';
import { Friendship } from '../models/Friendship';
import { body, validationResult } from 'express-validator';
import { sendPushToUser } from '../utils/push';
import { broadcastSse } from '../utils/sse';
import { getVapidPublicKey, isWebPushConfigured } from '../utils/webPush';

const router = express.Router();

function isPushSub(body: any): body is { endpoint: string; keys: { p256dh: string; auth: string } } {
  return (
    !!body &&
    typeof body.endpoint === 'string' &&
    body.endpoint.startsWith('https://') &&
    typeof body.keys?.p256dh === 'string' &&
    typeof body.keys?.auth === 'string'
  );
}

// GET /api/notifications/vapid-public-key — clave pública para suscribir el navegador
router.get('/vapid-public-key', (_req: Request, res: Response) => {
  res.json({
    publicKey: getVapidPublicKey(),
    configured: isWebPushConfigured(),
  });
});

// POST /api/notifications/web-push-subscription — guardar suscripción PWA
router.post('/web-push-subscription', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).userId || (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Usuario no autenticado' });
    if (!isPushSub(req.body)) {
      return res.status(400).json({ error: 'Suscripción Web Push no válida' });
    }
    const user = await User.findById(userId).select('webPushSubscriptions');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const next = [
      ...(user.webPushSubscriptions || []).filter((s) => s.endpoint !== req.body.endpoint),
      {
        endpoint: req.body.endpoint,
        keys: { p256dh: req.body.keys.p256dh, auth: req.body.keys.auth },
        createdAt: new Date(),
      },
    ].slice(-8);

    await User.findByIdAndUpdate(userId, { webPushSubscriptions: next });
    res.json({ message: 'Suscripción registrada' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/notifications/web-push-subscription — quitar este navegador
router.delete('/web-push-subscription', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).userId || (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Usuario no autenticado' });
    const endpoint =
      (typeof req.body?.endpoint === 'string' && req.body.endpoint.trim()) ||
      (typeof req.query.endpoint === 'string' && String(req.query.endpoint).trim()) ||
      '';
    if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });
    await User.findByIdAndUpdate(userId, { $pull: { webPushSubscriptions: { endpoint } } });
    res.json({ message: 'Suscripción eliminada' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/notifications/test-push — aviso real a este usuario (Expo + Web Push)
router.post('/test-push', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).userId || (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Usuario no autenticado' });
    await sendPushToUser(
      String(userId),
      'Powerlifting Tracker',
      'Aviso de prueba. Si lo ves, los avisos llegan aunque la app esté cerrada.',
      { type: '' }
    );
    res.json({ message: 'Aviso enviado' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

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
      const userId = (req as AuthRequest).userId || (req as any).user?.userId;
      if (!userId) return res.status(401).json({ error: 'Usuario no autenticado' });
      const token = String(req.body.token).trim();
      const user = await User.findById(userId).select('pushTokens');
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
      const merged = [
        ...new Set(
          [...(user.pushTokens || []), token].filter(
            (x): x is string => typeof x === 'string' && x.length > 0
          )
        ),
      ];
      await User.findByIdAndUpdate(userId, { pushTokens: merged });
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
      broadcastSse([String(friendUserId), String(fromUserId)], 'checkin_update');

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
