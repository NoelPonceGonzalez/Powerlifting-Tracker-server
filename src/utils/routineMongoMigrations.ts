import mongoose from 'mongoose';
import { Routine } from '../models/Routine';
import { TrainingMax } from '../models/TrainingMax';
import { HistoryEntry } from '../models/HistoryEntry';
import { InternalExerciseMax } from '../models/InternalExerciseMax';
import { logger } from './logger';
import {
  migrateRoutineEmbeddedLogsToExerciseLogs,
  migrateUnsetRoutineTopLevelWeeks,
} from './migrateExerciseLogs';
import { runNormalizedMigration } from './migrateToNormalized';

/**
 * Migraciones idempotentes al arranque: datos legados coherentes con rutina ↔ TM ↔ historial.
 * No sustituyen las comprobaciones en rutas GET (por si entra documento nuevo entre medias).
 */
export async function runRoutineMongoMigrations(): Promise<void> {
  try {
    await migrateOrphanTrainingMaxes();
    await migrateOrphanInternalExerciseMaxes();
    await migrateOrphanHistoryEntries();
    await normalizeActiveRoutineFlags();
    await migrateRoutineEmbeddedLogsToExerciseLogs();
    await migrateUnsetRoutineTopLevelWeeks();
    await runNormalizedMigration();
  } catch (e: unknown) {
    logger.error('runRoutineMongoMigrations', e instanceof Error ? e.message : e);
  }
}

async function migrateOrphanTrainingMaxes(): Promise<void> {
  const n = await TrainingMax.countDocuments({
    $or: [{ routineId: { $exists: false } }, { routineId: null }],
  });
  if (n === 0) return;
  logger.info(`[migration] TrainingMax sin routineId: ${n} documento(s)`);
  const userIds = await TrainingMax.distinct('userId', {
    $or: [{ routineId: { $exists: false } }, { routineId: null }],
  });
  for (const uid of userIds) {
    const active = await Routine.findOne({ userId: uid, isActive: true });
    const fallback =
      active || (await Routine.findOne({ userId: uid }).sort({ createdAt: 1 }));
    if (!fallback) {
      logger.warn(`[migration] Usuario ${uid} sin rutina; TM huérfanos no asignados`);
      continue;
    }
    const res = await TrainingMax.updateMany(
      { userId: uid, $or: [{ routineId: { $exists: false } }, { routineId: null }] },
      { $set: { routineId: fallback._id } }
    );
    if (res.modifiedCount > 0) {
      logger.info(
        `[migration] TM: usuario ${uid} → rutina ${fallback._id} (${res.modifiedCount} docs)`
      );
    }
  }
}

/** Legado: TM internos solo por usuario+nombre → asignar `routineId` (rutina activa o la más antigua). */
async function migrateOrphanInternalExerciseMaxes(): Promise<void> {
  const n = await InternalExerciseMax.countDocuments({
    $or: [{ routineId: { $exists: false } }, { routineId: null }],
  });
  if (n > 0) {
    logger.info(`[migration] InternalExerciseMax sin routineId: ${n} documento(s)`);
    const userIds = await InternalExerciseMax.distinct('userId', {
      $or: [{ routineId: { $exists: false } }, { routineId: null }],
    });
    for (const uid of userIds) {
      const uidTyped =
        uid instanceof mongoose.Types.ObjectId ? uid : new mongoose.Types.ObjectId(String(uid));
      const active = await Routine.findOne({ userId: uidTyped, isActive: true });
      const fallback =
        active || (await Routine.findOne({ userId: uidTyped }).sort({ createdAt: 1 }));
      if (!fallback) {
        logger.warn(`[migration] Usuario ${uid} sin rutina; eliminando InternalExerciseMax huérfanos`);
        await InternalExerciseMax.deleteMany({
          userId: uidTyped,
          $or: [{ routineId: { $exists: false } }, { routineId: null }],
        });
        continue;
      }
      await InternalExerciseMax.updateMany(
        { userId: uidTyped, $or: [{ routineId: { $exists: false } }, { routineId: null }] },
        { $set: { routineId: fallback._id } }
      );
    }
  }
  try {
    await InternalExerciseMax.collection.dropIndex('userId_1_nameNormalized_1');
    logger.info('[migration] Índice legado internalExerciseMax (userId+nameNormalized) eliminado');
  } catch {
    // no existe
  }
  try {
    await InternalExerciseMax.syncIndexes();
  } catch (e) {
    logger.warn('InternalExerciseMax.syncIndexes', e instanceof Error ? e.message : e);
  }
}

async function migrateOrphanHistoryEntries(): Promise<void> {
  const n = await HistoryEntry.countDocuments({
    $or: [{ routineId: { $exists: false } }, { routineId: null }],
  });
  if (n === 0) return;
  logger.info(`[migration] HistoryEntry sin routineId: ${n} documento(s)`);
  const userIds = await HistoryEntry.distinct('userId', {
    $or: [{ routineId: { $exists: false } }, { routineId: null }],
  });
  for (const uid of userIds) {
    const active = await Routine.findOne({ userId: uid, isActive: true });
    const fallback =
      active || (await Routine.findOne({ userId: uid }).sort({ createdAt: 1 }));
    if (!fallback) continue;
    const res = await HistoryEntry.updateMany(
      { userId: uid, $or: [{ routineId: { $exists: false } }, { routineId: null }] },
      { $set: { routineId: fallback._id } }
    );
    if (res.modifiedCount > 0) {
      logger.info(
        `[migration] Historial: usuario ${uid} → rutina ${fallback._id} (${res.modifiedCount} docs)`
      );
    }
  }
}

/** Exactamente una rutina activa por usuario (si hay rutinas). */
async function normalizeActiveRoutineFlags(): Promise<void> {
  const userIds = await Routine.distinct('userId');
  for (const uid of userIds) {
    const uidTyped = uid instanceof mongoose.Types.ObjectId ? uid : new mongoose.Types.ObjectId(String(uid));
    const activeCount = await Routine.countDocuments({ userId: uidTyped, isActive: true });
    const total = await Routine.countDocuments({ userId: uidTyped });
    if (total === 0) continue;

    if (activeCount === 0) {
      const first = await Routine.findOne({ userId: uidTyped }).sort({ createdAt: 1 });
      if (first) {
        await Routine.updateOne({ _id: first._id }, { $set: { isActive: true } });
        logger.info(`[migration] Usuario ${uidTyped}: activada rutina más antigua ${first._id}`);
      }
      continue;
    }

    if (activeCount > 1) {
      const actives = await Routine.find({ userId: uidTyped, isActive: true }).sort({
        updatedAt: -1,
      });
      const keep = actives[0];
      await Routine.updateMany(
        { userId: uidTyped, isActive: true, _id: { $ne: keep._id } },
        { $set: { isActive: false } }
      );
      logger.info(
        `[migration] Usuario ${uidTyped}: una sola rutina activa (conservada ${keep._id})`
      );
    }
  }
}
