/**
 * Migración one-shot: convierte datos legacy embebidos a colecciones normalizadas.
 * - Routine.versions/weeks/baseTemplate → ProgramVersion + TemplateWeek/Day/Exercise
 * - Routine.logs + ExerciseLog → WorkoutSession/Exercise/Set
 * - HistoryEntry.trainingMaxes → HistoryTmSnapshot
 * Seguro de ejecutar múltiples veces (idempotente por chequeo de existencia).
 */
import mongoose from 'mongoose';
import { Routine } from '../models/Routine';
import { ProgramVersion } from '../models/ProgramVersion';
import { TemplateWeek } from '../models/TemplateWeek';
import { TemplateDay } from '../models/TemplateDay';
import { TemplateExercise } from '../models/TemplateExercise';
import { WorkoutSession } from '../models/WorkoutSession';
import { WorkoutExercise } from '../models/WorkoutExercise';
import { WorkoutSet } from '../models/WorkoutSet';
import { HistoryEntry } from '../models/HistoryEntry';
import { HistoryTmSnapshot } from '../models/HistoryTmSnapshot';

const oid = (v: any) =>
  v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v));

function safeOid(v: any): mongoose.Types.ObjectId | undefined {
  if (v == null) return undefined;
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = String(v).trim();
  if (!/^[a-fA-F0-9]{24}$/.test(s)) return undefined;
  try { return new mongoose.Types.ObjectId(s); } catch { return undefined; }
}

const LOG_KEY_RE = /^w(\d+)-d(\d+)-e(\d+)$/;
const getWeekType = (n: number) => ((Math.max(1, n) - 1) % 4) + 1;

// ---------- Plan migration ----------

async function migratePlanForRoutine(routine: any) {
  const rid = oid(routine._id);
  const existing = await ProgramVersion.findOne({ routineId: rid });
  if (existing) return; // already migrated

  const versions: any[] = routine.versions || [];
  const baseTemplate: any[] = routine.baseTemplate || [];
  const weeks: any[] = routine.weeks || [];

  const templateSource =
    baseTemplate.length > 0
      ? baseTemplate
      : weeks.length >= 4
      ? extractTemplateFromWeeks(weeks)
      : weeks.slice(0, 4);

  if (templateSource.length === 0 && versions.length === 0) return;

  const effectiveVersions = versions.length > 0 ? versions : [{ effectiveFromWeek: 1 }];

  for (let vi = 0; vi < effectiveVersions.length; vi++) {
    const cv = effectiveVersions[vi];
    const pv = await ProgramVersion.create({
      routineId: rid,
      effectiveFromWeek: cv.effectiveFromWeek ?? 1,
      sortOrder: vi,
    });

    const tplToUse =
      vi === effectiveVersions.length - 1
        ? templateSource
        : cv.weeks
        ? extractTemplateFromWeeks(cv.weeks)
        : templateSource;

    for (let si = 0; si < Math.min(4, tplToUse.length); si++) {
      const tpl = tplToUse[si];
      const slot = si + 1;
      const tw = await TemplateWeek.create({ programVersionId: pv._id, slot });

      const days = Array.isArray(tpl.days) ? tpl.days : [];
      for (let di = 0; di < days.length; di++) {
        const day = days[di];
        const td = await TemplateDay.create({
          templateWeekId: tw._id,
          dayIndex: di,
          name: day.name || '',
          dayType: day.type || day.dayType || 'workout',
        });

        const exercises = Array.isArray(day.exercises) ? day.exercises : [];
        for (let ei = 0; ei < exercises.length; ei++) {
          const ex = exercises[ei];
          const reps = ex.reps;
          await TemplateExercise.create({
            templateDayId: td._id,
            sortOrder: ei,
            exerciseName: ex.name || ex.exerciseName || '',
            sets: ex.sets || 1,
            repsInt: typeof reps === 'number' ? reps : undefined,
            repsText: typeof reps === 'string' ? reps : undefined,
            pct: ex.pct,
            pctPerSet: Array.isArray(ex.pctPerSet) ? ex.pctPerSet : undefined,
            weight: ex.weight,
            mode: ex.mode || 'weight',
            linkedTrainingMaxId: safeOid(ex.linkedTo),
            linkedClientKey: safeOid(ex.linkedTo) ? undefined : (ex.linkedTo || undefined),
          });
        }
      }
    }
  }
}

function extractTemplateFromWeeks(weeks: any[]): any[] {
  const byType: Record<number, any> = {};
  for (const w of weeks) {
    const num = Number(w.number ?? 1);
    const type = getWeekType(num);
    if (!byType[type]) byType[type] = w;
  }
  return [1, 2, 3, 4].map((t) => byType[t] || weeks[0] || { days: [] });
}

// ---------- Logs migration ----------

async function migrateLogsForRoutine(routine: any) {
  const rid = oid(routine._id);
  const uid = oid(routine.userId);

  const existingSession = await WorkoutSession.findOne({ routineId: rid });
  if (existingSession) return;

  const allLogs: Record<string, any> = {};

  // Legacy embedded logs
  if (routine.logs && typeof routine.logs === 'object') {
    const legacyLogs = routine.logs instanceof Map ? Object.fromEntries(routine.logs) : routine.logs;
    Object.assign(allLogs, legacyLogs);
  }

  // ExerciseLog collection (created in previous migration step)
  try {
    const ExerciseLogModel = mongoose.connection.collection('exerciselogs');
    const logDocs = await ExerciseLogModel.find({ routineId: rid }).toArray();
    for (const doc of logDocs) {
      if (doc.logKey && !allLogs[doc.logKey]) {
        allLogs[doc.logKey] = {
          rpe: doc.rpe || '',
          notes: doc.notes || '',
          completed: !!doc.completed,
          weight: doc.weight,
          sets: doc.sets || [],
        };
      }
    }
  } catch {
    // collection may not exist
  }

  const now = new Date().toISOString().slice(0, 10);
  for (const [logKey, entry] of Object.entries(allLogs)) {
    if (!entry || typeof entry !== 'object') continue;
    const m = LOG_KEY_RE.exec(logKey);
    if (!m) continue;
    const planWeek = parseInt(m[1], 10);
    const planDayIndex = parseInt(m[2], 10);
    const exerciseIndex = parseInt(m[3], 10);

    let session = await WorkoutSession.findOne({ routineId: rid, planWeek, planDayIndex });
    if (!session) {
      session = await WorkoutSession.create({ userId: uid, routineId: rid, dateISO: now, planWeek, planDayIndex });
    }

    let we = await WorkoutExercise.findOne({ sessionId: session._id, exerciseIndex });
    if (!we) {
      we = await WorkoutExercise.create({
        sessionId: session._id,
        exerciseName: entry.exerciseName || '',
        exerciseIndex,
        notes: entry.notes ?? '',
        rpe: entry.rpe ?? '',
        completed: !!entry.completed,
        exerciseWeight: entry.weight,
      });
    }

    const sets = Array.isArray(entry.sets) ? entry.sets : [];
    for (let si = 0; si < sets.length; si++) {
      const s = sets[si];
      await WorkoutSet.updateOne(
        { workoutExerciseId: we._id, setIndex: si },
        {
          $set: {
            workoutExerciseId: we._id,
            setIndex: si,
            reps: s.reps != null ? Number(s.reps) : undefined,
            weight: s.weight != null ? Number(s.weight) : undefined,
            completed: !!s.completed,
            rpe: s.rpe ?? '',
            inputMode: s.inputMode || undefined,
          },
        },
        { upsert: true }
      );
    }
  }
}

// ---------- History TM migration ----------

async function migrateHistoryTmSnapshots() {
  const entries = await HistoryEntry.find({ trainingMaxes: { $exists: true, $ne: null } }).lean();
  let count = 0;
  for (const entry of entries) {
    const tmObj = (entry as any).trainingMaxes;
    if (!tmObj || typeof tmObj !== 'object') continue;
    const heId = oid(entry._id);

    const existing = await HistoryTmSnapshot.findOne({ historyEntryId: heId });
    if (existing) continue;

    const ops: any[] = [];
    for (const [tmId, value] of Object.entries(tmObj)) {
      if (!mongoose.Types.ObjectId.isValid(tmId)) continue;
      ops.push({
        updateOne: {
          filter: { historyEntryId: heId, trainingMaxId: oid(tmId) },
          update: { $set: { historyEntryId: heId, trainingMaxId: oid(tmId), value: Number(value) } },
          upsert: true,
        },
      });
    }
    if (ops.length > 0) {
      await HistoryTmSnapshot.bulkWrite(ops);
      count += ops.length;
    }

    // Set RM columns from rms field
    const rms = (entry as any).rms;
    if (rms && typeof rms === 'object') {
      await HistoryEntry.updateOne({ _id: heId }, {
        $set: {
          benchRm: rms.bench || undefined,
          squatRm: rms.squat || undefined,
          deadliftRm: rms.deadlift || undefined,
        },
      });
    }
  }
  if (count > 0) console.log(`[MIGRATE] Created ${count} HistoryTmSnapshot docs`);
}

/** Quita campos embebidos gigantes del documento Routine si ya hay plan normalizado COMPLETO. */
async function unsetLegacyRoutineEmbeddedFields(): Promise<void> {
  const routines = await Routine.find({}).select('_id weeks versions baseTemplate').lean();
  let n = 0;
  for (const r of routines) {
    const plain = r as Record<string, any>;
    const hasLegacyFields = plain.weeks || plain.versions || plain.baseTemplate;
    if (!hasLegacyFields) continue;

    const rid = oid(r._id);
    const pv = await ProgramVersion.findOne({ routineId: rid });
    if (!pv) continue;
    const twCount = await TemplateWeek.countDocuments({ programVersionId: pv._id });
    if (twCount < 4) continue;
    const twIds = (await TemplateWeek.find({ programVersionId: pv._id }).select('_id').lean()).map(tw => oid(tw._id));
    const tdCount = await TemplateDay.countDocuments({ templateWeekId: { $in: twIds } });
    if (tdCount < 4) continue;
    await Routine.collection.updateOne(
      { _id: r._id },
      { $unset: { weeks: '', logs: '', versions: '', baseTemplate: '', weekTypeOverrides: '' } }
    );
    n++;
  }
  if (n > 0) console.log(`[MIGRATE] Unset legacy embedded fields on ${n} Routine document(s)`);
}

// ---------- Seed default templates for routines with broken/incomplete data ----------

const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

const DEFAULT_EXERCISES_BY_DAY: Record<number, Array<{ name: string; sets: number; reps: number; mode: string; linkedClientKey?: string }>> = {
  0: [
    { name: 'Press Banca', sets: 3, reps: 5, mode: 'weight', linkedClientKey: 'tm-1' },
    { name: 'Press Militar', sets: 3, reps: 10, mode: 'weight' },
  ],
  2: [
    { name: 'Sentadilla', sets: 3, reps: 5, mode: 'weight', linkedClientKey: 'tm-2' },
  ],
  4: [
    { name: 'Peso Muerto', sets: 3, reps: 5, mode: 'weight', linkedClientKey: 'tm-3' },
  ],
};

async function isNormalizedDataComplete(routineId: mongoose.Types.ObjectId): Promise<boolean> {
  const pvs = await ProgramVersion.find({ routineId }).select('_id').lean();
  if (pvs.length === 0) return false;
  const pvIds = pvs.map(v => oid(v._id));
  const twCount = await TemplateWeek.countDocuments({ programVersionId: { $in: pvIds } });
  if (twCount < 4) return false;
  const twIds = (await TemplateWeek.find({ programVersionId: { $in: pvIds } }).select('_id').lean()).map(tw => oid(tw._id));
  if (twIds.length === 0) return false;
  const tdIds = (await TemplateDay.find({ templateWeekId: { $in: twIds } }).select('_id').lean()).map(td => oid(td._id));
  if (tdIds.length < 4) return false;
  const teCount = await TemplateExercise.countDocuments({ templateDayId: { $in: tdIds } });
  return teCount > 0;
}

async function deleteNormalizedDataForRoutine(routineId: mongoose.Types.ObjectId): Promise<void> {
  const pvs = await ProgramVersion.find({ routineId }).select('_id').lean();
  const pvIds = pvs.map(v => oid(v._id));
  if (pvIds.length === 0) return;
  const twIds = (await TemplateWeek.find({ programVersionId: { $in: pvIds } }).select('_id').lean()).map(tw => oid(tw._id));
  if (twIds.length > 0) {
    const tdIds = (await TemplateDay.find({ templateWeekId: { $in: twIds } }).select('_id').lean()).map(td => oid(td._id));
    if (tdIds.length > 0) await TemplateExercise.deleteMany({ templateDayId: { $in: tdIds } });
    await TemplateDay.deleteMany({ templateWeekId: { $in: twIds } });
  }
  await TemplateWeek.deleteMany({ programVersionId: { $in: pvIds } });
  await ProgramVersion.deleteMany({ routineId });
}

async function seedDefaultTemplateForRoutine(routineId: mongoose.Types.ObjectId): Promise<void> {
  const pv = await ProgramVersion.create({
    routineId,
    effectiveFromWeek: 1,
    sortOrder: 0,
  });

  for (let slot = 1; slot <= 4; slot++) {
    const tw = await TemplateWeek.create({ programVersionId: pv._id, slot });

    for (let di = 0; di < 7; di++) {
      const isWorkout = di === 0 || di === 2 || di === 4;
      const td = await TemplateDay.create({
        templateWeekId: tw._id,
        dayIndex: di,
        name: DAY_NAMES[di],
        dayType: isWorkout ? 'workout' : 'rest',
      });

      const exercises = DEFAULT_EXERCISES_BY_DAY[di] || [];
      for (let ei = 0; ei < exercises.length; ei++) {
        const ex = exercises[ei];
        await TemplateExercise.create({
          templateDayId: td._id,
          sortOrder: ei,
          exerciseName: ex.name,
          sets: ex.sets,
          repsInt: ex.reps,
          pct: 65 + (slot - 1) * 5,
          mode: ex.mode,
          linkedClientKey: ex.linkedClientKey,
        });
      }
    }
  }
}

async function repairBrokenNormalizedData(): Promise<void> {
  const routines = await Routine.find({}).select('_id').lean();
  let repaired = 0;
  for (const r of routines) {
    const rid = oid(r._id);
    const complete = await isNormalizedDataComplete(rid);
    if (complete) continue;

    await deleteNormalizedDataForRoutine(rid);
    await seedDefaultTemplateForRoutine(rid);
    repaired++;
  }
  if (repaired > 0) {
    console.log(`[MIGRATE] Repaired ${repaired} routine(s) with broken/incomplete normalized data`);
  }
}

// ---------- Main ----------

export async function runNormalizedMigration() {
  console.log('[MIGRATE] Starting normalized migration...');

  const routines = await Routine.find({}).lean();
  for (const r of routines) {
    try {
      await migratePlanForRoutine(r);
      await migrateLogsForRoutine(r);
    } catch (err: any) {
      console.error(`[MIGRATE] Error migrating routine ${r._id}:`, err.message);
    }
  }

  await migrateHistoryTmSnapshots();
  await repairBrokenNormalizedData();
  await unsetLegacyRoutineEmbeddedFields();
  await dropLegacyExerciseLogCollection();

  console.log('[MIGRATE] Normalized migration complete.');
}

/** Logs ya migrados a WorkoutSession/Exercise/Set — la colección legado ya no se usa. */
async function dropLegacyExerciseLogCollection(): Promise<void> {
  try {
    const db = mongoose.connection.db;
    if (!db) return;
    const cols = await db.listCollections({ name: 'exerciselogs' }).toArray();
    if (cols.length === 0) return;
    await db.dropCollection('exerciselogs');
    console.log('[MIGRATE] Dropped legacy collection: exerciselogs');
  } catch (e: unknown) {
    console.warn('[MIGRATE] Could not drop exerciselogs:', e instanceof Error ? e.message : e);
  }
}
