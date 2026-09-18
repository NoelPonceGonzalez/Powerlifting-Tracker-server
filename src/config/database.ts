import dns from 'dns';
import mongoose from 'mongoose';
import { config } from './env';
import { runRoutineMongoMigrations } from '../utils/routineMongoMigrations';
import { dropUnusedMongoCollections } from '../utils/dropUnusedMongoCollections';
import { backfillLegacyMutualFriendships } from '../utils/migrateFriendships';
import { dedupeUsersByEmail } from '../utils/dedupeUsersByEmail';
import { migrateInlineAvatars } from '../utils/avatarMedia';

/**
 * Muchos routers domésticos e ISPs no resuelven registros SRV, que es lo que usa
 * mongodb+srv://. El síntoma es siempre `querySrv ECONNREFUSED`. Si pasa, se
 * reintenta con DNS públicos antes de dar la conexión por perdida.
 */
const PUBLIC_DNS = ['1.1.1.1', '8.8.8.8'];

const RETRY_DELAYS_MS = [3000, 5000, 10000, 20000, 30000];

let connecting = false;
// `ReturnType<typeof setTimeout>` y no NodeJS.Timeout: client/server.ts compila este
// archivo con los tipos del DOM, donde setTimeout devuelve number.
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let dnsFallbackApplied = false;
let everConnected = false;

function isSrvDnsFailure(error: unknown): boolean {
  const e = error as { syscall?: string; code?: string } | null;
  if (!e) return false;
  return e.syscall === 'querySrv' || e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN';
}

/**
 * Se sustituye la lista entera en vez de anteponer los públicos: si el resolutor del
 * sistema rechaza SRV (típico de un DNS local en 127.0.0.1), dejarlo en la lista hace
 * que c-ares siga tropezando con él y el reintento falla igual.
 */
function applyPublicDnsFallback(): boolean {
  if (dnsFallbackApplied) return false;
  dnsFallbackApplied = true;
  try {
    dns.setServers(PUBLIC_DNS);
    console.warn(`⚠️  Tu DNS no resuelve el registro SRV de MongoDB. Reintentando con ${PUBLIC_DNS.join(' y ')}…`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Un resolutor en loopback suele ser un proxy DNS local (bloqueador de anuncios) y casi
 * nunca responde SRV. Se cambia antes del primer intento para no perder 8 s de timeout.
 */
function preemptPublicDnsIfLoopback(): void {
  if (!config.mongodbUri.startsWith('mongodb+srv://')) return;
  try {
    const servers = dns.getServers();
    const allLoopback =
      servers.length > 0 &&
      servers.every((s) => s.startsWith('127.') || s === '::1' || s.startsWith('[::1]'));
    if (!allLoopback) return;
    dnsFallbackApplied = true;
    dns.setServers(PUBLIC_DNS);
    console.warn(`⚠️  Tu DNS (${servers.join(', ')}) no resuelve SRV. Se usará ${PUBLIC_DNS.join(' y ')} para MongoDB.`);
  } catch {
    /* si falla, queda el reintento reactivo */
  }
}

/** ¿Hay internet? Sirve para distinguir "estoy sin red" de "ese cluster ya no existe". */
async function hasWorkingDns(): Promise<boolean> {
  try {
    await dns.promises.resolve('mongodb.net', 'NS');
    return true;
  } catch {
    return false;
  }
}

async function describeFailure(error: unknown): Promise<string> {
  const e = error as { message?: string; syscall?: string } | null;

  if (isSrvDnsFailure(error)) {
    // ECONNREFUSED es el resolutor rechazando la consulta, no un dominio inexistente:
    // decir aquí "el cluster no existe" mandaba a recrear un cluster que estaba bien.
    if ((error as { code?: string } | null)?.code === 'ECONNREFUSED') {
      return [
        'tu servidor DNS rechaza las consultas SRV que necesita mongodb+srv://.',
        `   DNS actual: ${dns.getServers().join(', ') || 'desconocido'}`,
        '   Suele ser un proxy DNS local (bloqueador de anuncios) o el router.',
        `   Se reintenta con ${PUBLIC_DNS.join(' y ')}; si insiste, usa la cadena sin +srv de Atlas.`,
      ].join('\n');
    }
    if (await hasWorkingDns()) {
      return [
        'el cluster de la cadena de conexión no existe (DNS: dominio inexistente).',
        '   Tienes internet y mongodb.net responde, así que no es tu red: ese cluster',
        '   fue eliminado o renombrado en MongoDB Atlas.',
        '   Crea uno nuevo y pon su cadena en MONGODB_URI dentro de server/.env',
      ].join('\n');
    }
    return [
      'no se ha podido resolver la dirección de MongoDB (DNS).',
      '   Parece que estás sin internet o el router bloquea las consultas SRV.',
      '   El servidor seguirá reintentando solo.',
    ].join('\n');
  }

  if (/authentication failed/i.test(e?.message ?? '')) {
    return 'usuario o contraseña incorrectos. Revisa MONGODB_URI en server/.env';
  }
  if (/IP.*whitelist|not allowed to connect/i.test(e?.message ?? '')) {
    return 'tu IP no está autorizada en MongoDB Atlas. Añádela en Network Access.';
  }
  if (/ECONNREFUSED .*27017/i.test(e?.message ?? '')) {
    return 'no hay ningún MongoDB escuchando en esa dirección. ¿Está arrancado?';
  }
  return e?.message ?? String(error);
}

async function attemptConnection(): Promise<void> {
  if (connecting || mongoose.connection.readyState === 1) return;
  connecting = true;

  try {
    await mongoose.connect(config.mongodbUri, {
      // Sin esto, cada petición se queda colgada 10 s esperando a Mongo en vez de fallar rápido.
      serverSelectionTimeoutMS: 8000,
    });
    attempt = 0;
    everConnected = true;
    console.log('✅ MongoDB conectado exitosamente');
    console.log(`   Base de datos: ${mongoose.connection.name}`);
    await runRoutineMongoMigrations();
    console.log('✅ Migraciones de rutinas / TM / historial aplicadas (idempotentes)');
    await backfillLegacyMutualFriendships();
    console.log('✅ Amistades antiguas comprobadas (parejas de un solo documento → las dos direcciones)');
    await dedupeUsersByEmail();
    console.log('✅ Cuentas duplicadas por email comprobadas (un correo = una cuenta)');
    await migrateInlineAvatars();
    await dropUnusedMongoCollections();
  } catch (error) {
    // El primer fallo de SRV puede ser solo el DNS del router: se reintenta ya con DNS públicos.
    if (isSrvDnsFailure(error) && !dnsFallbackApplied && applyPublicDnsFallback()) {
      connecting = false;
      return attemptConnection();
    }

    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    attempt += 1;

    // El diagnóstico largo solo la primera vez; repetirlo en cada reintento tapa el resto del log.
    if (attempt === 1) {
      console.error(`❌ MongoDB: ${await describeFailure(error)}`);
      console.log(`   El servidor sigue funcionando y reintentando en segundo plano.`);
    } else {
      console.log(`   MongoDB sin conexión (intento ${attempt}); siguiente en ${Math.round(delay / 1000)} s`);
    }
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      connecting = false;
      void attemptConnection();
    }, delay);
    // Que el reintento pendiente no impida cerrar el proceso (solo existe en Node).
    (retryTimer as { unref?: () => void }).unref?.();
    return;
  } finally {
    connecting = false;
  }
}

/**
 * Conecta con MongoDB sin tumbar el proceso si falla: el servidor HTTP sigue en pie
 * y se reintenta en segundo plano. Así un corte de red no obliga a reiniciar todo.
 */
export const connectDB = async (): Promise<void> => {
  if (!process.env.MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI no está definida en server/.env: se usa la cadena por defecto del código.');
  }

  preemptPublicDnsIfLoopback();

  // Solo interesa avisar de caídas reales: en cada intento fallido mongoose también
  // emite 'disconnected' y llenaría la consola sin aportar nada.
  mongoose.connection.on('disconnected', () => {
    if (everConnected) console.warn('⚠️  MongoDB desconectado. Reintentando…');
  });
  mongoose.connection.on('reconnected', () => console.log('✅ MongoDB reconectado'));

  await attemptConnection();
};

/** true cuando hay conexión utilizable; lo usan las rutas para responder 503 en vez de colgarse. */
export const isDbConnected = (): boolean => mongoose.connection.readyState === 1;

export default mongoose.connection;
