import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';

export interface AuthRequest extends Request {
  userId?: string;
  user?: any;
}

export const authenticateToken = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    res.status(401).json({ error: 'Token de acceso requerido' });
    return;
  }

  jwt.verify(token, config.jwtSecret, async (err: any, decoded: any) => {
    if (err) {
      res.status(403).json({ error: 'Token inválido o expirado' });
      return;
    }

    req.userId = decoded.userId;
    req.user = decoded;
    
    // Obtener información completa del usuario si es necesario
    try {
      const { User } = await import('../models/User');
      const user = await User.findById(decoded.userId).select('name email avatar');
      if (user) {
        req.user = { ...decoded, name: user.name, email: user.email, avatar: user.avatar };
      }
    } catch (dbErr) {
      // Si falla, continuar con decoded básico
    }
    
    next();
  });
};

export const generateToken = (userId: string, email: string): string => {
  return jwt.sign({ userId, email }, config.jwtSecret);
};
