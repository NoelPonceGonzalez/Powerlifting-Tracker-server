import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth';
import { SbdEntry } from '../models/SbdEntry';
import { User } from '../models/User';
import { mutualFriendIds } from '../utils/friendship';
import { ipfGlEquippedPoints } from '../utils/challengeScoring';
import { publicListAvatar } from '../utils/avatarMedia';

const router = express.Router();

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
    res.json({
      me: mine
        ? { squat: lift(mine.squat), bench: lift(mine.bench), deadlift: lift(mine.deadlift) }
        : { squat: 0, bench: 0, deadlift: 0 },
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
    await SbdEntry.findOneAndUpdate(
      { userId: new mongoose.Types.ObjectId(userId) },
      { squat, bench, deadlift },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
