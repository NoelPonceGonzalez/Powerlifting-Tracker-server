import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth';
import { SbdEntry } from '../models/SbdEntry';
import { User } from '../models/User';
import { mutualFriendIds } from '../utils/friendship';
import { ipfGlEquippedPoints } from '../utils/challengeScoring';
import { publicListAvatar } from '../utils/avatarMedia';
import { TrainingMax } from '../models/TrainingMax';
import { HistoryEntry } from '../models/HistoryEntry';
import { Notification } from '../models/Notification';
import { sendPushToUsers } from '../utils/push';

const router = express.Router();

async function bestFromTraining(userId: string) {
  const oid = new mongoose.Types.ObjectId(userId);
  const [tms, history] = await Promise.all([
    TrainingMax.find({ userId: oid, mode: 'weight', linkedExercise: { $in: ['squat', 'bench', 'deadlift'] } })
      .select('linkedExercise value')
      .lean(),
    HistoryEntry.find({ userId: oid }).select('squatRm benchRm deadliftRm').lean(),
  ]);
  const out = { squat: 0, bench: 0, deadlift: 0 };
  for (const tm of tms) {
    const key = tm.linkedExercise as 'squat' | 'bench' | 'deadlift' | undefined;
    const value = Number(tm.value);
    if (key && value > out[key]) out[key] = value;
  }
  for (const row of history) {
    if (Number(row.squatRm) > out.squat) out.squat = Number(row.squatRm);
    if (Number(row.benchRm) > out.bench) out.bench = Number(row.benchRm);
    if (Number(row.deadliftRm) > out.deadlift) out.deadlift = Number(row.deadliftRm);
  }
  return { squat: lift(out.squat), bench: lift(out.bench), deadlift: lift(out.deadlift) };
}

function lift(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.round(v * 10) / 10;
}

router.get('/sbd', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user.userId);
    const friendIds = await mutualFriendIds(userId);
    const ids = [userId, ...friendIds];
    const [entries, users] = await Promise.all([
      SbdEntry.find({ userId: { $in: ids } }).lean(),
      User.find({ _id: { $in: ids } }).select('name avatar bodyWeight gender').lean(),
    ]);
    const byUser = new Map(users.map(u => [String(u._id), u]));
    const board = entries
      .map(entry => {
        const user = byUser.get(String(entry.userId));
        if (!user) return null;
        const squat = lift(entry.squat);
        const bench = lift(entry.bench);
        const deadlift = lift(entry.deadlift);
        if (squat <= 0 || bench <= 0 || deadlift <= 0) return null;
        const total = Math.round((squat + bench + deadlift) * 10) / 10;
        const gender = user.gender === 'mujer' ? 'mujer' : 'hombre';
        const bodyWeight = Number(user.bodyWeight) > 0 ? Number(user.bodyWeight) : 0;
        return {
          id: String(entry.userId),
          name: user.name || 'Atleta',
          avatar: publicListAvatar(user.avatar, String(entry.userId)) || null,
          squat,
          bench,
          deadlift,
          total,
          points: ipfGlEquippedPoints(total, bodyWeight, gender),
          mine: String(entry.userId) === userId,
        };
      })
      .filter((row): row is NonNullable<typeof row> => !!row)
      .sort((a, b) => b.points - a.points || b.total - a.total);

    const mine = entries.find(e => String(e.userId) === userId);
    const suggested = await bestFromTraining(userId);
    res.json({
      me: mine
        ? { squat: lift(mine.squat), bench: lift(mine.bench), deadlift: lift(mine.deadlift) }
        : { squat: 0, bench: 0, deadlift: 0 },
      suggested,
      board,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/sbd', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user.userId);
    const squat = lift(req.body?.squat);
    const bench = lift(req.body?.bench);
    const deadlift = lift(req.body?.deadlift);
    if (squat <= 0 || bench <= 0 || deadlift <= 0) {
      return res.status(400).json({ error: 'Pon sentadilla, banca y peso muerto.' });
    }
    const prev = await SbdEntry.findOne({ userId: new mongoose.Types.ObjectId(userId) }).lean();
    const changed = !prev || lift(prev.squat) !== squat || lift(prev.bench) !== bench || lift(prev.deadlift) !== deadlift;
    await SbdEntry.findOneAndUpdate(
      { userId: new mongoose.Types.ObjectId(userId) },
      { squat, bench, deadlift },
      { upsert: true, new: true }
    );
    if (changed) {
      const me = await User.findById(userId).select('name').lean();
      const friendIds = await mutualFriendIds(userId);
      const title = `${me?.name || 'Un amigo'} ha actualizado su SBD`;
      const message = `${squat} · ${bench} · ${deadlift} kg`;
      if (friendIds.length > 0) {
        await Notification.insertMany(
          friendIds.map((id) => ({
            userId: new mongoose.Types.ObjectId(id),
            type: 'sbd_update',
            title,
            message,
            relatedUserId: new mongoose.Types.ObjectId(userId),
            relatedData: { kind: 'sbd' },
            read: false,
          }))
        );
        await sendPushToUsers(friendIds, title, message, { type: 'sbd_update', relatedUserId: userId });
      }
    }
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
