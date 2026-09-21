import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';

export interface AuthRequest extends Request {
  userId?: string;
  user?: any;
}

type TokenPayload = {
  userId?: string;
  email?: string;
  sv?: number;
};

async function attachUserAndCheckSession(
  decoded: TokenPayload,
  req: AuthRequest,
  res: Response
): Promise<boolean> {
  req.userId = decoded.userId;
  req.user = decoded;

  try {
    const { User } = await import('../models/User');
    const user = await User.findById(decoded.userId).select('name email avatar sessionVersion');
    if (!user) {
      res.status(403).json({ error: 'Token inválido o expirado' });
      return false;
    }
    const sv = user.sessionVersion ?? 0;
    if (typeof decoded.sv === 'number') {
      if (decoded.sv !== sv) {
        res.status(403).json({ error: 'Sesión cerrada en otro dispositivo', code: 'session_revoked' });
        return false;
      }
    } else if (sv > 0) {
      res.status(403).json({ error: 'Sesión cerrada en otro dispositivo', code: 'session_revoked' });
      return false;
    }
    req.user = { ...decoded, name: user.name, email: user.email, avatar: user.avatar };
  } catch {
    // Si falla la BD, seguir con el token (igual que antes) para no petar el gym.
  }

  return true;
}

function readBearer(req: Request): string {
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.split(' ')[1] ? authHeader.split(' ')[1] : '';
}

export const authenticateToken = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  const token = readBearer(req);

  if (!token) {
    res.status(401).json({ error: 'Token de acceso requerido' });
    return;
  }

  jwt.verify(token, config.jwtSecret, async (err: any, decoded: any) => {
    if (err) {
      res.status(403).json({ error: 'Token inválido o expirado' });
      return;
    }
    if (!(await attachUserAndCheckSession(decoded, req, res))) return;
    next();
  });
};

/** Solo /auth/refresh: admite un JWT caducado si la firma y la sesión siguen siendo válidas. */
export const authenticateAllowExpired = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  const token = readBearer(req);

  if (!token) {
    res.status(401).json({ error: 'Token de acceso requerido' });
    return;
  }

  jwt.verify(token, config.jwtSecret, { ignoreExpiration: true }, async (err: any, decoded: any) => {
    if (err) {
      res.status(403).json({ error: 'Token inválido' });
      return;
    }
    if (!(await attachUserAndCheckSession(decoded, req, res))) return;
    next();
  });
};

export const generateToken = (userId: string, email: string, sv = 0): string => {
  return jwt.sign({ userId, email, sv }, config.jwtSecret);
};

export async function issueToken(userId: string, email: string): Promise<string> {
  const { User } = await import('../models/User');
  const user = await User.findById(userId).select('sessionVersion').lean();
  return generateToken(userId, email, user?.sessionVersion ?? 0);
}
