import crypto from 'crypto';
import { logger } from './logger';

// Importación dinámica de bcryptjs para evitar problemas con ES modules
let bcrypt: any;

async function getBcrypt() {
  if (!bcrypt) {
    try {
      bcrypt = await import('bcryptjs');
      // Manejar tanto importación por defecto como namespace
      if (bcrypt.default) {
        bcrypt = bcrypt.default;
      }
      logger.info('bcryptjs cargado correctamente');
    } catch (error: any) {
      logger.error('Error cargando bcryptjs', error);
      throw error;
    }
  }
  return bcrypt;
}

export const generateVerificationToken = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

export const hashPassword = async (password: string): Promise<string> => {
  if (!password) {
    throw new Error('Password is required');
  }
  const bcryptLib = await getBcrypt();
  const salt = await bcryptLib.genSalt(10);
  return bcryptLib.hash(password, salt);
};

export const comparePassword = async (
  password: string,
  hashedPassword: string
): Promise<boolean> => {
  try {
    if (!password || !hashedPassword) {
      logger.warn('comparePassword - Password o hash vacío', { 
        hasPassword: !!password, 
        hasHashedPassword: !!hashedPassword 
      });
      return false;
    }
    
    const bcryptLib = await getBcrypt();
    
    if (!bcryptLib || !bcryptLib.compare) {
      logger.error('comparePassword - bcryptLib no tiene método compare', { 
        bcryptLibExists: !!bcryptLib,
        hasCompare: !!(bcryptLib?.compare)
      });
      throw new Error('bcryptjs no está correctamente inicializado');
    }
    
    const result = await bcryptLib.compare(password, hashedPassword);
    return result;
  } catch (error: any) {
    logger.error('comparePassword - Error comparando contraseña', error);
    throw error;
  }
};
