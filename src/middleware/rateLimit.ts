import { Request, Response, NextFunction } from 'express';

type Bucket = { n: number; reset: number };
const hits = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of hits) {
    if (b.reset <= now) hits.delete(k);
  }
}, 60_000).unref?.();

function clientKey(req: Request) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.ip || req.socket.remoteAddress || 'unknown';
}

/** Holgado: no peta el gym. Solo para /auth sensible y búsqueda. */
export function rateLimit(opts: { windowMs: number; max: number; name: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${opts.name}:${clientKey(req)}`;
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || cur.reset <= now) {
      hits.set(key, { n: 1, reset: now + opts.windowMs });
      return next();
    }
    cur.n += 1;
    if (cur.n > opts.max) {
      const retry = Math.max(1, Math.ceil((cur.reset - now) / 1000));
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ error: 'Demasiados intentos. Espera un momento.' });
    }
    return next();
  };
}

export const authBurstLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, name: 'auth' });
export const searchBurstLimit = rateLimit({ windowMs: 60 * 1000, max: 90, name: 'search' });
