import { Post } from '../models/Post';
import { PostComment } from '../models/PostComment';
import { ChatMessage } from '../models/ChatMessage';
import { Notification } from '../models/Notification';
import { CHAT_MEDIA_LIFETIME_MS } from './chatMedia';
import { mediaStorage } from './mediaStorage';
import { logger, sweepAppLogs } from './logger';

const ACTIVITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TEST_NOTE = /prueba|aviso de prueba|notificaciones ya llegan/i;

/**
 * El índice TTL de Mongo borra el documento pero no el archivo: si nos quedamos solo con él,
 * las fotos y vídeos de las historias se acumularían para siempre en disco (o en S3).
 * Por eso la barrida propia va por delante y el TTL queda de red de seguridad con margen.
 */
const TTL_GRACE_SECONDS = 3 * 24 * 60 * 60;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const BATCH = 200;

/** Deja el TTL con margen para que nunca se lleve el documento antes de borrar el archivo. */
export async function ensureStoryTtlGrace(): Promise<void> {
  const indexes = await Post.collection.indexes().catch(() => [] as any[]);
  const ttl = indexes.find((i: any) => i.name === 'expiresAt_1');
  if (ttl && ttl.expireAfterSeconds !== TTL_GRACE_SECONDS) {
    await Post.collection.dropIndex('expiresAt_1').catch(() => {});
  }
  await Post.collection
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: TTL_GRACE_SECONDS })
    .catch(() => {});
}

/** Borra historias caducadas: primero el archivo, luego comentarios y documento. */
export async function sweepExpiredStories(): Promise<number> {
  const expired = await Post.find({ kind: 'story', expiresAt: { $lte: new Date() } })
    .select('_id mediaKey')
    .limit(BATCH)
    .lean();
  if (expired.length === 0) return 0;

  const storage = mediaStorage();
  await Promise.all(
    expired.map(s =>
      storage.remove(s.mediaKey).catch(e => logger.warn(`No se pudo borrar el medio ${s.mediaKey}`, e))
    )
  );

  const ids = expired.map(s => s._id);
  await PostComment.deleteMany({ postId: { $in: ids } });
  await ChatMessage.updateMany(
    { 'storyReply.postId': { $in: ids.map(id => String(id)) } },
    { $set: { 'storyReply.mediaKey': '' } }
  );
  await Post.deleteMany({ _id: { $in: ids } });

  logger.info(`[historias] ${expired.length} caducadas borradas (archivo incluido)`);
  return expired.length;
}

/** Quita del disco las fotos/vídeos de chat que ya han cumplido 24 h; el texto se queda. */
export async function sweepExpiredChatMedia(): Promise<number> {
  const now = new Date();
  const legacyCutoff = new Date(now.getTime() - CHAT_MEDIA_LIFETIME_MS);
  const expired = await ChatMessage.find({
    mediaKey: { $nin: [null, ''] },
    $or: [
      { mediaExpiresAt: { $lte: now } },
      {
        $and: [
          { $or: [{ mediaExpiresAt: null }, { mediaExpiresAt: { $exists: false } }] },
          { createdAt: { $lte: legacyCutoff } },
        ],
      },
    ],
  })
    .select('_id mediaKey')
    .limit(BATCH)
    .lean();
  if (expired.length === 0) return 0;

  const storage = mediaStorage();
  await Promise.all(
    expired.map(m =>
      m.mediaKey
        ? storage.remove(m.mediaKey).catch(e => logger.warn(`No se pudo borrar el medio de chat ${m.mediaKey}`, e))
        : Promise.resolve()
    )
  );

  await ChatMessage.updateMany(
    { _id: { $in: expired.map(m => m._id) } },
    { $set: { mediaKey: null, mediaType: null, mediaExpiresAt: null } }
  );

  logger.info(`[chat] ${expired.length} fotos/vídeos caducados borrados`);
  return expired.length;
}

/** Actividad: se va a la semana. También se quitan avisos de prueba. */
export async function sweepOldNotifications(): Promise<number> {
  const cutoff = new Date(Date.now() - ACTIVITY_TTL_MS);
  const res = await Notification.deleteMany({
    $or: [
      { createdAt: { $lt: cutoff } },
      { title: TEST_NOTE },
      { message: TEST_NOTE },
    ],
  });
  const n = res.deletedCount || 0;
  if (n > 0) logger.info(`[actividad] ${n} avisos viejos o de prueba borrados`);
  return n;
}

/** Arranca la limpieza periódica; devuelve el temporizador por si hace falta pararlo. */
export function startStoryCleanup(): NodeJS.Timeout {
  const run = () => {
    void sweepExpiredStories().catch(e => logger.warn('[historias] barrida fallida', e));
    void sweepExpiredChatMedia().catch(e => logger.warn('[chat] barrida de medios fallida', e));
    void sweepOldNotifications().catch(e => logger.warn('[actividad] barrida fallida', e));
    try {
      const trimmed = sweepAppLogs();
      if (trimmed > 0) logger.info(`[logs] ${trimmed} archivo(s) recortados`);
    } catch (e) {
      logger.warn('[logs] barrida fallida', e);
    }
  };
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
