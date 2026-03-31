import express from 'express';
import cors from 'cors';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { connectDB } from './config/database';
import { config, getCorsAllowedOrigins } from './config/env';
import { logger } from './utils/logger';
import authRoutes from './routes/auth';
import routinesRoutes from './routes/routines';
import trainingMaxesRoutes from './routes/trainingMaxes';
import socialRoutes from './routes/social';
import checkinsRoutes from './routes/checkins';
import notificationsRoutes from './routes/notifications';
import challengesRoutes from './routes/challenges';
import internalExerciseMaxesRoutes from './routes/internalExerciseMaxes';
import { formatApiRequestLogLine } from './utils/apiRequestLogLabel';
import { processFinishedChallengeWinnerNotifications } from './utils/challengeFinishedNotifications';

/** Build de Vite en ../client/dist — misma carpeta raíz que `server/`. La WebView de Expo hace GET / aquí. */
const __filename = fileURLToPath(import.meta.url);
const __dirnameFromFile = dirname(__filename);
const CLIENT_DIST = join(__dirnameFromFile, '../../client/dist');
const CLIENT_INDEX = join(CLIENT_DIST, 'index.html');

const app = express();

// Middleware básico (CORS y parsing)
// Producción: APP_URL + CORS_ORIGINS (AWS). Localhost solo si NODE_ENV≠production o ALLOW_LOCALHOST_CORS=true
app.use(cors({
  origin: (origin, callback) => {
    const allowed = getCorsAllowedOrigins();
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn(`CORS: origen no permitido: ${origin}`);
      callback(null, false);
    }
  },
  credentials: true,
}));
/** Rutinas con muchas semanas + logs de series superan el límite por defecto de Express (~100kb) → PayloadTooLargeError. */
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '15mb';
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));

// Middleware de logging: solo `/api/*`, una línea (sin JSON ni cabeceras)
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const line = formatApiRequestLogLine(req.path || '', req.method, req.body);
  if (line) logger.info(line);
  next();
});

// Health check
app.get('/health', (req, res) => {
  logger.info('GET /health - Health check solicitado');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/routines', routinesRoutes);
app.use('/api/training-maxes', trainingMaxesRoutes);
app.use('/api/social', socialRoutes);
app.use('/api/checkins', checkinsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/challenges', challengesRoutes);
app.use('/api/internal-exercise-maxes', internalExerciseMaxesRoutes);

// --- Interfaz web (React) en el mismo puerto: necesaria para la app Expo (WebView → GET /) ---
if (existsSync(CLIENT_INDEX)) {
  app.use(
    express.static(CLIENT_DIST, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        }
      },
    })
  );
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(CLIENT_INDEX);
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .type('html')
      .send(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width"/><title>API Powerlifting</title></head>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.5;">
<h1>Solo API (sin interfaz web generada)</h1>
<p>Este proceso sirve <code>/api/…</code> y <code>/health</code>, pero <strong>no hay</strong> la app React en <code>GET /</code>.</p>
<p><strong>App móvil (Expo):</strong> abre otra terminal en la carpeta <code>client</code> y ejecuta:</p>
<pre style="background:#f1f5f9;padding:12px;border-radius:8px;overflow:auto;">cd client
npm run dev</pre>
<p>Eso arranca Vite + API en un solo servidor (interfaz + API).</p>
<p><strong>O</strong> genera el build y reinicia este servidor:</p>
<pre style="background:#f1f5f9;padding:12px;border-radius:8px;">cd client
npm run build</pre>
<p>Luego este servidor podrá servir los archivos de <code>client/dist</code>.</p>
</body></html>`);
  });
}

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    logger.warn('Payload demasiado grande', { path: req.path, limit: JSON_BODY_LIMIT });
    return res.status(413).json({
      error: 'El cuerpo de la petición es demasiado grande. Si persiste, contacta soporte.',
    });
  }
  logger.error('Error en middleware de manejo de errores', err);
  res.status(err.status || 500).json({
    error: err.message || 'Error interno del servidor',
  });
});

// Conectar a MongoDB y iniciar servidor
const startServer = async () => {
  try {
    logger.info('Iniciando servidor...');
    await connectDB();
    
    const server = app.listen(Number(config.port), '0.0.0.0', () => {
      const startupMessage = `Servidor corriendo en puerto ${config.port}`;
      console.log(`\n✅ ${startupMessage}`);
      if (config.nodeEnv === 'production' && config.appUrl) {
        console.log(`   APP_URL (público): ${config.appUrl}`);
      }
      if (config.nodeEnv !== 'production' || process.env.ALLOW_LOCALHOST_CORS === 'true') {
        console.log(`   Local: http://localhost:${config.port}`);
      }
      if (config.nodeEnv === 'production' && !config.appUrl && !process.env.CORS_ORIGINS) {
        logger.warn(
          'Producción sin APP_URL ni CORS_ORIGINS: configura el dominio del frontend (AWS) en variables de entorno.'
        );
      }
      if (!existsSync(CLIENT_INDEX)) {
        console.log(
          `\n⚠️  App móvil (Expo WebView): GET / no sirve la interfaz hasta que exista client/dist.\n` +
            `    Desarrollo recomendado: otra terminal → cd client → npm run dev\n` +
            `    O: cd client → npm run build → reinicia este servidor.\n`
        );
        logger.warn(
          'Sin client/dist/index.html: la WebView del emulador (http://10.0.2.2:3000/) no cargará la app React.'
        );
      } else {
        console.log(`\n📱 Interfaz web: estática desde client/dist (GET /)\n`);
      }
      console.log(`\n📧 Email configurado: ${config.email.user}`);
      console.log(`\n⏳ Esperando conexiones...\n`);
      logger.info(startupMessage);
      logger.info(`📁 Logs guardados en: ${process.cwd()}/logs/`);

      const runWinnerNotifications = () => {
        processFinishedChallengeWinnerNotifications().catch((err) =>
          logger.error('Notificaciones de torneos finalizados', err)
        );
      };
      setTimeout(runWinnerNotifications, 15_000);
      setInterval(runWinnerNotifications, 5 * 60 * 1000);
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `\n❌ El puerto ${config.port} ya está en uso (EADDRINUSE).\n` +
            `   Cierra el otro proceso (otra terminal con npm run dev, o el servidor unificado en client/)\n` +
            `   o usa otro puerto: PowerShell → $env:PORT=3010; npm run dev\n`
        );
        process.exit(1);
      }
      throw err;
    });
  } catch (error: any) {
    logger.error('Error iniciando servidor', error);
    console.error('❌ Error iniciando servidor:', error);
    process.exit(1);
  }
};

startServer();
