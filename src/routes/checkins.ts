import express, { Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { GymCheckIn } from '../models/GymCheckIn';
import { Notification } from '../models/Notification';
import { Friendship } from '../models/Friendship';
import { body, validationResult } from 'express-validator';
import { broadcastSse } from '../utils/sse';

const router = express.Router();

// POST /api/checkins - Crear un check-in de gimnasio
router.post(
  '/',
  authenticateToken,
  [
    body('gymName').trim().notEmpty().withMessage('El nombre del gimnasio es requerido'),
    body('time').matches(/^\d{2}:\d{2}$/).withMessage('El formato de hora debe ser HH:MM'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = String((req as any).user?.userId ?? (req as any).userId ?? '');
      const userName = (req as any).user?.name || (req as any).user?.email || 'Usuario';
      const { gymName, time } = req.body;

      if (!userId) {
        return res.status(401).json({ error: 'Usuario no autenticado' });
      }

      const now = new Date();
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(now);
      dayEnd.setHours(23, 59, 59, 999);

      // Un único horario por día y usuario: si ya existe, se actualiza.
      const existingToday = await GymCheckIn.findOne({
        userId,
        timestamp: { $gte: dayStart, $lte: dayEnd },
      });

      let checkIn;
      let isNewCheckIn = false;
      if (existingToday) {
        existingToday.userName = userName;
        existingToday.gymName = gymName;
        existingToday.time = time;
        existingToday.timestamp = now;
        await existingToday.save();
        checkIn = existingToday;
      } else {
        checkIn = new GymCheckIn({
          userId,
          userName,
          gymName,
          time,
          timestamp: now,
        });
        await checkIn.save();
        isNewCheckIn = true;
      }

      // Obtener todos los amigos del usuario (requester/recipient son ObjectIds)
      const friendships = await Friendship.find({
        $or: [{ requester: userId }, { recipient: userId }],
        status: 'accepted',
      });

      const friendIds = friendships.map(f => {
        const reqStr = f.requester.toString();
        const recStr = f.recipient.toString();
        return reqStr === userId ? recStr : reqStr;
      });

      // Crear notificaciones in-app y push para todos los amigos
      if (friendIds.length > 0 && isNewCheckIn) {
        const notifTitle = `${userName} va a entrenar`;
        const notifMessage = `${gymName} a las ${time}`;

        const notifications = friendIds.map(friendId => ({
          userId: friendId,
          type: 'gym_checkin' as const,
          title: notifTitle,
          message: notifMessage,
          relatedUserId: userId,
          relatedData: {
            gymName,
            time,
          },
        }));

        await Notification.insertMany(notifications);
        try {
          const { sendPushToUsers } = await import('../utils/push');
          await sendPushToUsers(
            friendIds,
            notifTitle,
            notifMessage,
            { type: 'gym_checkin', gymName, time }
          );
        } catch (e) {
          console.error('[PUSH] Error gym_checkin:', e);
        }
      }

      broadcastSse([userId, ...friendIds], 'checkin_update');

      res.status(201).json(checkIn);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// PUT /api/checkins/:id - Editar check-in propio (hora y/o gym). Notifica a amigos si cambia la hora.
router.put(
  '/:id',
  authenticateToken,
  [
    body('gymName').optional().trim(),
    body('time').optional().matches(/^\d{2}:\d{2}$/).withMessage('El formato de hora debe ser HH:MM'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const userId = String((req as any).user?.userId ?? (req as any).userId ?? '');
      const userName = (req as any).user?.name || (req as any).user?.email || 'Usuario';
      const { gymName, time } = req.body;
      const checkInId = req.params.id;
      if (!userId) return res.status(401).json({ error: 'Usuario no autenticado' });

      const checkIn = await GymCheckIn.findOne({ _id: checkInId, userId });
      if (!checkIn) return res.status(404).json({ error: 'Check-in no encontrado' });

      const oldTime = checkIn.time;
      const oldGymName = checkIn.gymName;
      if (gymName !== undefined) checkIn.gymName = gymName;
      if (time !== undefined) checkIn.time = time;
      checkIn.userName = userName;
      checkIn.timestamp = new Date();
      await checkIn.save();

      const friendships = await Friendship.find({
        $or: [{ requester: userId }, { recipient: userId }],
        status: 'accepted',
      });
      const friendIds = friendships.map(f => {
        const reqStr = f.requester.toString();
        const recStr = f.recipient.toString();
        return reqStr === userId ? recStr : reqStr;
      });

      const editedTime = time !== undefined && time !== oldTime;
      const editedGym = gymName !== undefined && gymName !== oldGymName;
      if (friendIds.length > 0 && (editedTime || editedGym)) {
        const notifTitle = `${userName} ha editado su hora de entreno`;
        const notifMessage = `Ahora es ${checkIn.time} en ${checkIn.gymName}`;
        const notifications = friendIds.map(friendId => ({
          userId: friendId,
          type: 'gym_checkin' as const,
          title: notifTitle,
          message: notifMessage,
          relatedUserId: userId,
          relatedData: { gymName: checkIn.gymName, time: checkIn.time },
        }));
        await Notification.insertMany(notifications);
        try {
          const { sendPushToUsers } = await import('../utils/push');
          await sendPushToUsers(friendIds, notifTitle, notifMessage, { type: 'gym_checkin', gymName: checkIn.gymName, time: checkIn.time });
        } catch (e) {
          console.error('[PUSH] Error gym_checkin edit:', e);
        }
      }
      broadcastSse([userId, ...friendIds], 'checkin_update');

      res.json(checkIn);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// DELETE /api/checkins/:id - Eliminar check-in propio
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Usuario no autenticado' });
    const checkIn = await GymCheckIn.findOne({ _id: req.params.id, userId });
    if (!checkIn) return res.status(404).json({ error: 'Check-in no encontrado' });
    await GymCheckIn.deleteOne({ _id: req.params.id, userId });

    const friendships = await Friendship.find({
      $or: [{ requester: userId }, { recipient: userId }],
      status: 'accepted',
    });
    const friendIds = friendships.map(f => {
      const reqStr = f.requester.toString();
      const recStr = f.recipient.toString();
      return reqStr === String(userId) ? recStr : reqStr;
    });
    broadcastSse([String(userId), ...friendIds], 'checkin_update');

    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/checkins - Obtener check-ins (de amigos y propios)
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;

    // Obtener lista de amigos
    const friendships = await Friendship.find({
      $or: [{ requester: userId }, { recipient: userId }],
      status: 'accepted',
    });

    const friendIds = friendships.map(f => 
      f.requester.toString() === userId ? f.recipient : f.requester
    );

    // Obtener check-ins de amigos y propios (últimas 24 horas)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const checkIns = await GymCheckIn.find({
      userId: { $in: [...friendIds, userId] },
      timestamp: { $gte: oneDayAgo },
    })
      .populate('userId', 'name email avatar')
      .sort({ timestamp: -1 })
      .limit(50);

    const seenByUserAndDay = new Set<string>();
    const formatted = checkIns
      .filter(ci => {
        const rawUserId = typeof ci.userId === 'object' ? (ci.userId as any)._id?.toString?.() || (ci.userId as any).toString?.() : String(ci.userId);
        const day = ci.timestamp.toISOString().slice(0, 10);
        const key = `${rawUserId}-${day}`;
        if (seenByUserAndDay.has(key)) return false;
        seenByUserAndDay.add(key);
        return true;
      })
      .map(ci => {
      const userDoc = ci.userId as any;
      const userId = userDoc?._id?.toString?.() || userDoc?.id || (typeof ci.userId === 'object' ? (ci.userId as any).toString?.() : String(ci.userId));
      const userName = userDoc?.name || userDoc?.email || 'Usuario';
      return {
        id: ci._id.toString(),
        userId,
        userName,
        avatar: userDoc?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(userName)}`,
        gymName: ci.gymName,
        time: ci.time,
        timestamp: ci.timestamp.getTime(),
      };
    });

    res.json(formatted);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
