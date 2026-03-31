import dotenv from 'dotenv';

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

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv,
  jwtSecret: process.env.JWT_SECRET || 'powerlifting-super-secret-jwt-key-2026',
  mongodbUri: process.env.MONGODB_URI || 'mongodb+srv://root:OM5efz85AL4SB4Ad@power.ax8gn87.mongodb.net/?appName=Power',
  /** Si true, al arrancar se borran colecciones en la BD que no correspondan a ningún modelo de la app. */
  mongodbDropUnusedCollections: truthy(process.env.MONGODB_DROP_UNUSED_COLLECTIONS),
  email: {
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    user: process.env.EMAIL_USER || 'noel.ponce.gonzalez@gmail.com',
    pass: process.env.EMAIL_PASS || 'osam pwxk watx ensq',
    from: process.env.EMAIL_FROM || 'noreply@powerliftingtracker.com',
  },
  appUrl: defaultAppUrl,
  mobileAppScheme: process.env.MOBILE_APP_SCHEME || 'powerliftingtracker',
};

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
