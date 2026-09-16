import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Este módulo se evalúa al importarlo, antes de que quien arranca pueda llamar a
 * dotenv. Si solo leyera el .env del directorio actual, arrancar desde client/
 * (npm start) ignoraría por completo server/.env. Por eso se carga aquí, por ruta.
 */
const currentDir = path.dirname(fileURLToPath(import.meta.url));
// src/config/env.ts y dist/config/env.js: en ambos casos server/.env está dos niveles arriba.
dotenv.config({ path: path.resolve(currentDir, '..', '..', '.env') });
// El .env del directorio de arranque puede añadir cosas, pero no pisa lo anterior.
dotenv.config();

const truthy = (v: string | undefined) => {
  const t = v?.trim().toLowerCase();
  return t === 'true' || t === '1' || t === 'yes';
};

const nodeEnv = process.env.NODE_ENV || 'development';


/** En producción (p. ej. AWS) no asumir localhost: usa APP_URL o CORS_ORIGINS. */
const defaultAppUrl =
  process.env.APP_URL?.trim() ||
  (nodeEnv === 'production' ? '' : 'http://localhost:3000');

const isProduction = nodeEnv === 'production';

/**
 * Ninguna credencial vive en el código: todas salen de server/.env (ver .env.example).
 * En producción se corta el arranque si falta alguna crítica; en desarrollo se avisa
 * y se sigue, para poder trastear sin configurarlo todo.
 */
function requiredSecret(name: string, devFallback: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (isProduction) {
    throw new Error(
      `Falta la variable de entorno ${name}. Defínela en el servidor antes de arrancar en producción.`
    );
  }
  console.warn(`⚠️  ${name} no está definida: se usa un valor solo para desarrollo local.`);
  return devFallback;
}

const emailUser = process.env.EMAIL_USER?.trim() || '';
const emailPass = process.env.EMAIL_PASS?.trim() || '';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv,
  // Cambiar este valor invalida todas las sesiones abiertas: los usuarios tendrán que volver a entrar.
  jwtSecret: requiredSecret('JWT_SECRET', 'dev-only-jwt-secret-no-usar-en-produccion'),
  mongodbUri: process.env.MONGODB_URI?.trim() || 'mongodb://127.0.0.1:27017/powerlifting',
  /** Si true, al arrancar se borran colecciones en la BD que no correspondan a ningún modelo de la app. */
  mongodbDropUnusedCollections: truthy(process.env.MONGODB_DROP_UNUSED_COLLECTIONS),
  email: {
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    user: emailUser,
    pass: emailPass,
    from: process.env.EMAIL_FROM || 'noreply@powerliftingtracker.com',
    /** Sin credenciales no se intenta enviar nada: el código de verificación se muestra por consola. */
    enabled: Boolean(emailUser && emailPass),
  },
  appUrl: defaultAppUrl,
  mobileAppScheme: process.env.MOBILE_APP_SCHEME || 'powerliftingtracker',
};

/** Preview/producción en Vercel: el origen cambia en cada deploy. */
export function isAllowedVercelOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && (u.hostname === 'vercel.app' || u.hostname.endsWith('.vercel.app'));
  } catch {
    return false;
  }
}

/** Orígenes permitidos para CORS. En producción no se incluye localhost salvo ALLOW_LOCALHOST_CORS=true. */
export function getCorsAllowedOrigins(): string[] {
  const list: string[] = [];
  if (config.appUrl) list.push(config.appUrl.replace(/\/$/, ''));
  const extra = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  list.push(...extra);
  list.push('null');
  const allowLocal =
    config.nodeEnv !== 'production' || truthy(process.env.ALLOW_LOCALHOST_CORS);
  if (allowLocal) {
    list.push(
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://10.0.2.2:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      'http://10.0.2.2:3001',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:4173',
      'http://127.0.0.1:4173',
    );
  }
  return [...new Set(list)];
}

/** Base HTTPS del sitio para enlaces en emails / HTML (en producción debe ser APP_URL; en local, localhost). */
export function getPublicWebBaseUrl(): string {
  const u = (config.appUrl || '').trim().replace(/\/$/, '');
  if (u) return u;
  if (config.nodeEnv !== 'production') return 'http://localhost:3000';
  return '';
}
