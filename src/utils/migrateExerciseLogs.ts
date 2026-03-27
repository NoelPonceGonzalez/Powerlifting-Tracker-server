import mongoose from 'mongoose';
import { Routine } from '../models/Routine';
import { ExerciseLog } from '../models/ExerciseLog';
import { logger } from './logger';
function getLatestVersionWeeks(routine: any): any[] | null {
  const versions = routine.versions;
  if (Array.isArray(versions) && versions.length > 0) {
    const latest = versions.reduce((a: any, b: any) =>
      a.effectiveFromWeek >= b.effectiveFromWeek ? a : b
    );
    if (latest?.weeks && Array.isArray(latest.weeks) && latest.weeks.length > 0) {
      return latest.weeks;
    }
  }
  return null;
}

const CHUNK = 500;

/**
 * Migra `logs` embebidos en Routine → colección ExerciseLog y elimina el mapa embebido.
 * Idempotente: upsert por (routineId, logKey).
 */
export async function migrateRoutineEmbeddedLogsToExerciseLogs(): Promise<void> {
  let migrated = 0;
  const routines = await Routine.find({}).lean();
  for (const r of routines) {
    const raw = (r as any).logs;
    if (raw == null) continue;
    const entries =
      raw instanceof Map
        ? [...raw.entries()]
        : typeof raw === 'object' && !Array.isArray(raw)
          ? Object.entries(raw as Record<string, unknown>)
          : [];
    if (entries.length === 0) continue;

    const rid =
      r._id instanceof mongoose.Types.ObjectId ? r._id : new mongoose.Types.ObjectId(String(r._id));
    const uid =
      r.userId instanceof mongoose.Types.ObjectId
        ? r.userId
        : new mongoose.Types.ObjectId(String(r.userId));

    const ops: any[] = [];
    for (const [logKey, v] of entries) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const val = v as Record<string, any>;
      const sets = Array.isArray(val.sets)
        ? val.sets.map((s: any) => ({
            id: s?.id != null ? String(s.id) : '0',
            reps: s?.reps != null && s.reps !== '' ? s.reps : null,
            weight: s?.weight != null && s.weight !== '' ? s.weight : null,
            completed: !!s?.completed,
            ...(s?.inputMode === 'kg' || s?.inputMode === 'pct' ? { inputMode: s.inputMode } : {}),
          }))
        : [];
      ops.push({
        updateOne: {
          filter: { routineId: rid, logKey: String(logKey) },
          update: {
            $set: {
              userId: uid,
              routineId: rid,
              logKey: String(logKey),
              rpe: val.rpe != null ? String(val.rpe) : '',
              notes: val.notes != null ? String(val.notes) : '',
              completed: !!val.completed,
              ...(val.weight != null && Number.isFinite(Number(val.weight)) ? { weight: Number(val.weight) } : {}),
              sets,
            },
          },
          upsert: true,
        },
      });
    }
    for (let i = 0; i < ops.length; i += CHUNK) {
      await ExerciseLog.bulkWrite(ops.slice(i, i + CHUNK));
    }
    await Routine.collection.updateOne({ _id: rid }, { $unset: { logs: 1 } });
    migrated += 1;
  }
  if (migrated > 0) {
    logger.info(`[migration] ExerciseLog: migrados logs embebidos en ${migrated} rutina(s)`);
  }
}

/**
 * Asegura `versions[].weeks` y quita el duplicado `weeks` en la raíz cuando la versión ya lleva el plan.
 */
export async function migrateUnsetRoutineTopLevelWeeks(): Promise<void> {
  let n = 0;
  const routines = await Routine.find({ weeks: { $exists: true } }).lean();
  for (const r of routines) {
    const rid =
      r._id instanceof mongoose.Types.ObjectId ? r._id : new mongoose.Types.ObjectId(String(r._id));

    let latestWeeks = getLatestVersionWeeks(r);
    if (!latestWeeks?.length && Array.isArray((r as any).weeks) && (r as any).weeks.length > 0) {
      await Routine.collection.updateOne(
        { _id: rid },
        { $set: { versions: [{ effectiveFromWeek: 1, weeks: (r as any).weeks }] } }
      );
      latestWeeks = (r as any).weeks;
    }

    if (latestWeeks?.length) {
      await Routine.collection.updateOne({ _id: rid }, { $unset: { weeks: 1 } });
      n += 1;
    }
  }
  if (n > 0) {
    logger.info(`[migration] Routine: eliminado campo duplicado weeks en ${n} documento(s)`);
  }
}
