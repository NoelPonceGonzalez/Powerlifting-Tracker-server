import express, { Request, Response } from 'express';
import { createReadStream, existsSync, statSync } from 'fs';
import { extname, join, resolve, sep } from 'path';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { extractAvatarMediaKey, isAvatarMediaKey, isInlineAvatar, isOwnAvatarPointer } from '../utils/avatarMedia';
import { mediaStorage } from '../utils/mediaStorage';
import { config } from '../config/env';

function mediaTokenOk(req: Request): boolean {
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const q = typeof req.query.t === 'string' ? req.query.t : '';
  const token = bearer || q;
  if (!token) return false;
  try {
    jwt.verify(token, config.jwtSecret);
    return true;
  } catch {
    return false;
  }
}

const router = express.Router();

const DATA_RE = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([a-z0-9+/=\s]+)$/i;

const LOCAL_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Fotos subidas antes de S3 siguen en el disco del servidor. */
function readLocalAvatar(key: string): { stream: ReturnType<typeof createReadStream>; mimeType: string; size: number } | null {
  const root = resolve(process.env.MEDIA_LOCAL_DIR || join(process.cwd(), 'uploads'));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  const full = resolve(join(root, key));
  if (!full.startsWith(rootWithSep) || !existsSync(full)) return null;
  const size = statSync(full).size;
  const mimeType = LOCAL_MIME[extname(full).toLowerCase()] || 'image/jpeg';
  return { stream: createReadStream(full), mimeType, size };
}

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

    const key =
      extractAvatarMediaKey(raw) ||
      (isAvatarMediaKey(raw) || /^\d{6}\/[-\w.]+\.[a-z0-9]+$/i.test(raw) ? raw : '');
    if (key) {
      const storage = mediaStorage();
      // Se sirve desde la API: un redirect a otro host deja la foto en la letra inicial.
      const found = (await storage.read(key)) || readLocalAvatar(key);
      if (found) {
        res.setHeader('Content-Type', found.mimeType);
        res.setHeader('Content-Length', String(found.size));
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        return found.stream.pipe(res);
      }
      const direct = await storage.publicUrl(key);
      if (direct) return res.redirect(302, direct);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).end();
    }

    // Nunca redirigir a localhost ni a /api/media/user/:id (bucle → letra inicial).
    if (/^https?:\/\//i.test(raw) && !isOwnAvatarPointer(raw)) return res.redirect(raw);
    return res.status(404).end();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Historias/chat: el `<img>` no manda cabecera, así que el JWT va en `?t=`.
 * Los avatares `/user/:id` siguen públicos (salen en búsqueda).
 */
router.get('/:folder/:file', async (req: Request, res: Response) => {
  try {
    const requireJwt = process.env.MEDIA_REQUIRE_JWT === '1' || process.env.MEDIA_REQUIRE_JWT === 'true';
    if (requireJwt && !mediaTokenOk(req)) {
      return res.status(401).json({ error: 'Token de acceso requerido' });
    }
    const key = `${req.params.folder}/${req.params.file}`;
    const storage = mediaStorage();
    const direct = await storage.publicUrl(key);
    if (direct) return res.redirect(302, direct);
    const etag = `"${key}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    const inm = req.headers['if-none-match'];
    if (inm) {
      const tags = String(inm).split(',').map(part => part.trim());
      if (tags.includes('*') || tags.includes(etag)) {
        res.status(304).end();
        return;
      }
    }
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
      return chunk.stream.pipe(res);
    }

    const found = await storage.read(key);
    if (!found) return res.status(404).json({ error: 'Archivo no encontrado' });
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(found.size));
    res.setHeader('Content-Type', found.mimeType);
    return found.stream.pipe(res);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
