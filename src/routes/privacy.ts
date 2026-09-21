import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth';
import { User } from '../models/User';
import { applyBlock, loadPrivacy } from '../utils/privacy';
import { publicListAvatar } from '../utils/avatarMedia';
import { follows } from '../utils/friendship';

const router = express.Router();

function cards(ids: string[]) {
  return User.find({ _id: { $in: ids } })
    .select('name avatar')
    .lean()
    .then(rows =>
      rows.map(u => ({
        id: String(u._id),
        name: u.name || 'Atleta',
        avatar: publicListAvatar(u.avatar, String(u._id)),
      }))
    );
}

router.get('/close-friends', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const { close } = await loadPrivacy(me);
    res.json({ ids: [...close], people: await cards([...close]) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/close-friends', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const target = String(req.body?.userId || '');
    const on = req.body?.on !== false;
    if (!mongoose.isValidObjectId(target) || target === me) {
      return res.status(400).json({ error: 'Usuario no válido' });
    }
    if (on && !(await follows(me, target))) {
      return res.status(400).json({ error: 'Solo puedes añadir a quien sigues' });
    }
    const oid = new mongoose.Types.ObjectId(target);
    if (on) await User.updateOne({ _id: me }, { $addToSet: { closeFriendIds: oid } });
    else await User.updateOne({ _id: me }, { $pull: { closeFriendIds: oid } });
    const { close } = await loadPrivacy(me);
    res.json({ ok: true, on, ids: [...close] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/blocked', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const { blocked } = await loadPrivacy(me);
    res.json({ ids: [...blocked], people: await cards([...blocked]) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/block', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const target = String(req.body?.userId || '');
    if (!mongoose.isValidObjectId(target)) return res.status(400).json({ error: 'Usuario no válido' });
    await applyBlock(me, target);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/block/:userId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const target = String(req.params.userId || '');
    if (!mongoose.isValidObjectId(target)) return res.status(400).json({ error: 'Usuario no válido' });
    await User.updateOne({ _id: me }, { $pull: { blockedUserIds: new mongoose.Types.ObjectId(target) } });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/report', authenticateToken, async (req: Request, res: Response) => {
  try {
    const me = String((req as any).user.userId);
    const target = String(req.body?.userId || '');
    const reason = String(req.body?.reason || '').trim().slice(0, 400);
    if (!mongoose.isValidObjectId(target)) return res.status(400).json({ error: 'Usuario no válido' });
    console.warn('[report]', { me, target, reason: reason || 'sin motivo' });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
