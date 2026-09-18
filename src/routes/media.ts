import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../models/User';
import { isAvatarMediaKey, isInlineAvatar } from '../utils/avatarMedia';
import { mediaStorage } from '../utils/mediaStorage';

const router = express.Router();

const DATA_RE = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([a-z0-9+/=\s]+)$/i;

/** Foto de perfil por id: <img> no puede mandar JWT. */
router.get('/user/:userId', async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!mongoose.isValidObjectId(userId)) return res.status(404).end();
    const user = await User.findById(userId).select('avatar').lean();
    const raw = String(user?.avatar || '').trim();
    if (!raw) return res.status(404).end();

    if (isInlineAvatar(raw)) {
      const m = DATA_RE.exec(raw);
      if (!m) return res.status(404).end();
      const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
      const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'private, max-age=120');
      return res.send(buf);
    }

    if (isAvatarMediaKey(raw) || /^\d{6}\/[-\w.]+\.[a-z0-9]+$/i.test(raw)) {
      const found = await mediaStorage().read(raw);
      if (!found) return res.status(404).end();
      res.setHeader('Content-Type', found.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return found.stream.pipe(res);
    }

    if (/^https?:\/\//i.test(raw)) return res.redirect(raw);
    return res.status(404).end();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Sirve fotos y vídeos del feed. Va sin token a propósito: las etiquetas `<img>` y `<video>` no
 * pueden mandar cabeceras, y la clave es un UUID imposible de adivinar. Admite rangos para que
 * el reproductor pueda avanzar el vídeo sin descargarlo entero.
 */
router.get('/:folder/:file', async (req: Request, res: Response) => {
  try {
    const key = `${req.params.folder}/${req.params.file}`;
    const storage = mediaStorage();
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const total = await storage.size(key);
      if (total == null) return res.status(404).json({ error: 'Archivo no encontrado' });
      const match = /bytes=(\d*)-(\d*)/.exec(String(rangeHeader));
      const start = match && match[1] ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
      if (Number.isNaN(start) || start >= total || start > end) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      const chunk = await storage.read(key, { start, end });
      if (!chunk) return res.status(404).json({ error: 'Archivo no encontrado' });
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${chunk.totalSize}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', String(chunk.size));
      res.setHeader('Content-Type', chunk.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      return chunk.stream.pipe(res);
    }

    const found = await storage.read(key);
    if (!found) return res.status(404).json({ error: 'Archivo no encontrado' });
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(found.size));
    res.setHeader('Content-Type', found.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    return found.stream.pipe(res);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
