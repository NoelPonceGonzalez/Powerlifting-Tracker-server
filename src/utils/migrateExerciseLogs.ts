import mongoose from 'mongoose';
import { Routine } from '../models/Routine';
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
