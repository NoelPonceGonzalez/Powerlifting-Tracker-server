import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { addSseClient, getSseClientCount } from '../utils/sse';

const router = express.Router();

/**
 * SSE auth: EventSource doesn't support custom headers, so accept the
 * JWT via ?token= query parameter in addition to the Authorization header.
 */
function authenticateSse(req: Request, res: Response, next: NextFunction): void {
  const token =
    (req.query.token as string) ||
    req.headers['authorization']?.split(' ')[1];

  if (!token) {
    res.status(401).json({ error: 'Token requerido' });
    return;
  }

  jwt.verify(token, config.jwtSecret, (err: any, decoded: any) => {
    if (err) {
      res.status(403).json({ error: 'Token inválido o expirado' });
      return;
    }
    (req as any).userId = decoded.userId;
    next();
  });
}

router.get('/stream', authenticateSse, (req: Request, res: Response) => {
  const userId = (req as any).userId;
  if (!userId) {
    res.status(401).json({ error: 'No autenticado' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  addSseClient(userId, res);

  req.on('close', () => {
    /* cleanup handled inside addSseClient */
  });
});

router.get('/status', (_req: Request, res: Response) => {
  res.json({ clients: getSseClientCount() });
});

export default router;
