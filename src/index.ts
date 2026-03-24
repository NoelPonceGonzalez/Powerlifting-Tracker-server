import express from 'express';
import cors from 'cors';
import { connectDB } from './config/database';
import { config } from './config/env';
import { logger } from './utils/logger';
import authRoutes from './routes/auth';
import routinesRoutes from './routes/routines';
import trainingMaxesRoutes from './routes/trainingMaxes';
import socialRoutes from './routes/social';
import checkinsRoutes from './routes/checkins';
import notificationsRoutes from './routes/notifications';
import challengesRoutes from './routes/challenges';
import internalExerciseMaxesRoutes from './routes/internalExerciseMaxes';

const app = express();

// Middleware básico (CORS y parsing)
// Permite app web, app móvil (file:// → Origin: null) y localhost
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      config.appUrl,
      'null',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://10.0.2.2:3000',
    ].filter(Boolean);
    if (!origin || allowed.includes(origin) || allowed.includes('null')) {
      callback(null, true);
    } else {
      callback(null, config.appUrl);
    }
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware de logging para TODAS las peticiones (después de parsear el body)
app.use((req, res, next) => {
  const logData: any = {
    method: req.method,
    path: req.path,
    ip: req.ip || req.socket.remoteAddress,
    headers: {
      'content-type': req.headers['content-type'],
      'user-agent': req.headers['user-agent']?.substring(0, 50)
    }
  };
  
  // Agregar body si existe (ocultar password)
  if (req.body && Object.keys(req.body).length > 0) {
    if (req.body.password) {
      logData.body = { ...req.body, password: '[REDACTED]' };
    } else {
      logData.body = req.body;
    }
  }
  
  logger.info(`${req.method} ${req.path}`, logData);
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

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
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
    
    app.listen(Number(config.port), '0.0.0.0', () => {
      const startupMessage = `Servidor corriendo en puerto ${config.port}`;
      console.log(`\n✅ ${startupMessage}`);
      console.log(`   http://localhost:${config.port}`);
      console.log(`\n📧 Email configurado: ${config.email.user}`);
      console.log(`\n⏳ Esperando conexiones...\n`);
      logger.info(startupMessage);
      logger.info(`📁 Logs guardados en: ${process.cwd()}/logs/`);
    });
  } catch (error: any) {
    logger.error('Error iniciando servidor', error);
    console.error('❌ Error iniciando servidor:', error);
    process.exit(1);
  }
};

startServer();
