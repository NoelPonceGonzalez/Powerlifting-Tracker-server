import { Post } from '../models/Post';
import { PostComment } from '../models/PostComment';
import { mediaStorage } from './mediaStorage';
import { logger } from './logger';

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
  await Post.deleteMany({ _id: { $in: ids } });

  logger.info(`[historias] ${expired.length} caducadas borradas (archivo incluido)`);
  return expired.length;
}

/** Arranca la limpieza periódica; devuelve el temporizador por si hace falta pararlo. */
export function startStoryCleanup(): NodeJS.Timeout {
  const run = () => {
    void sweepExpiredStories().catch(e => logger.warn('[historias] barrida fallida', e));
  };
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
