import mongoose from 'mongoose';
import { config } from '../config/env';
import { getAppMongoCollectionNames } from '../models/appCollectionNames';
import { logger } from './logger';

/**
 * Elimina colecciones que existen en la base de datos pero no pertenecen a los modelos
 * registrados de esta app (restos de pruebas, esquemas viejos, nombres mal escritos, etc.).
 *
 * ⚠️ Desactivado por defecto. Activa solo con `MONGODB_DROP_UNUSED_COLLECTIONS=true` en `.env`.
 * Nunca borra colecciones `system.*` ni las listadas en `appCollectionNames.ts`.
 */
export async function dropUnusedMongoCollections(): Promise<void> {
  if (!config.mongodbDropUnusedCollections) {
    return;
  }
  console.warn(
    '[MongoDB] MONGODB_DROP_UNUSED_COLLECTIONS está activo: se eliminarán colecciones no listadas en appCollectionNames.ts'
  );

  const db = mongoose.connection.db;
  if (!db) {
    logger.warn('[MongoDB] dropUnusedMongoCollections: sin conexión a db');
    return;
  }

  const allowed = getAppMongoCollectionNames();
  let existing: { name: string }[];
  try {
    existing = await db.listCollections().toArray();
  } catch (e) {
    logger.error('[MongoDB] listCollections falló', e instanceof Error ? e.message : e);
    return;
  }

  const dropped: string[] = [];
  const failed: string[] = [];

  for (const col of existing) {
    const name = col.name;
    if (!name || name.startsWith('system.')) continue;
    if (allowed.has(name)) continue;

    try {
      await db.dropCollection(name);
      dropped.push(name);
    } catch (e) {
      failed.push(name);
      logger.warn(`[MongoDB] No se pudo eliminar colección "${name}"`, e instanceof Error ? e.message : e);
    }
  }

  if (dropped.length) {
    console.log(`[MongoDB] Colecciones no usadas eliminadas (${dropped.length}): ${dropped.join(', ')}`);
    logger.info(`[MongoDB] dropUnused: eliminadas ${dropped.length} colección(es)`, { dropped });
  } else {
    console.log('[MongoDB] Sin colecciones huérfanas que eliminar (o ninguna extra en la BD).');
  }
  if (failed.length) {
    logger.warn(`[MongoDB] dropUnused: ${failed.length} colección(es) no eliminadas`, { failed });
  }
}
