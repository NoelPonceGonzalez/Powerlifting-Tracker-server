/**
 * Ensamblado: lee colecciones normalizadas y devuelve la forma que el cliente espera.
 * Desensamblado: recibe la forma del cliente y persiste en colecciones.
 */
import mongoose from 'mongoose';
import { ProgramVersion } from '../models/ProgramVersion';
import { TemplateWeek } from '../models/TemplateWeek';
import { TemplateDay } from '../models/TemplateDay';
import { TemplateExercise } from '../models/TemplateExercise';
import { WorkoutSession } from '../models/WorkoutSession';
import { WorkoutExercise } from '../models/WorkoutExercise';
import { WorkoutSet } from '../models/WorkoutSet';
import { HistoryTmSnapshot } from '../models/HistoryTmSnapshot';
import { InternalExerciseMax } from '../models/InternalExerciseMax';
import { ExerciseLog } from '../models/ExerciseLog';

const oid = (v: any) =>
  v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v));

/** El cliente usa linkedTo tipo "tm-1"; solo persistimos ObjectId si es 24 hex. */
function safeLinkedTrainingMaxId(ex: { linkedTo?: string }): mongoose.Types.ObjectId | undefined {
  const id = ex.linkedTo;
  if (id == null || String(id).trim() === '') return undefined;
  const s = String(id).trim();
  if (!/^[a-fA-F0-9]{24}$/.test(s)) return undefined;
  try {
    return new mongoose.Types.ObjectId(s);
  } catch {
    return undefined;
  }
}

function linkedClientKeyFromExercise(ex: { linkedTo?: string }): string | undefined {
  if (safeLinkedTrainingMaxId(ex)) return undefined;
  const id = ex.linkedTo;
  if (id == null || String(id).trim() === '') return undefined;
  const s = String(id).trim();
  if (s.length > 128) return undefined;
  return s;
}

// ---------------------------------------------------------------------------
//  LEER colecciones → JSON para el cliente
// ---------------------------------------------------------------------------

/** Lee ProgramVersion + TemplateWeek/Day/Exercise y devuelve la forma versions+baseTemplate+weekTypeOverrides del cliente. */
export async function assembleRoutinePlan(routineId: mongoose.Types.ObjectId) {
  const versions = await ProgramVersion.find({ routineId }).sort({ effectiveFromWeek: 1 }).lean();

  const versionIds = versions.map((v) => oid(v._id));
  const allTW = await TemplateWeek.find({ programVersionId: { $in: versionIds } }).lean();
  const twIds = allTW.map((tw) => oid(tw._id));
  const allTD = await TemplateDay.find({ templateWeekId: { $in: twIds } }).sort({ dayIndex: 1 }).lean();
  const tdIds = allTD.map((td) => oid(td._id));
  const allTE = await TemplateExercise.find({ templateDayId: { $in: tdIds } }).sort({ sortOrder: 1 }).lean();

  const teByDay = new Map<string, any[]>();
  for (const te of allTE) {
    const k = String(te.templateDayId);
    if (!teByDay.has(k)) teByDay.set(k, []);
    teByDay.get(k)!.push(te);
  }
  const tdByWeek = new Map<string, any[]>();
  for (const td of allTD) {
    const k = String(td.templateWeekId);
    if (!tdByWeek.has(k)) tdByWeek.set(k, []);
    tdByWeek.get(k)!.push(td);
  }
  const twByVersion = new Map<string, any[]>();
  for (const tw of allTW) {
    const k = String(tw.programVersionId);
    if (!twByVersion.has(k)) twByVersion.set(k, []);
    twByVersion.get(k)!.push(tw);
  }

  function exerciseToClient(te: any, dayIdx: number, exIdx: number, slotOrWeek: string): any {
    const reps = te.repsInt != null ? te.repsInt : te.repsText ?? '';
    return {
      id: `${slotOrWeek}-d${dayIdx}-e${exIdx + 1}`,
      _dbId: String(te._id),
      name: te.exerciseName,
      sets: te.sets,
      reps,
      ...(te.pct != null ? { pct: te.pct } : {}),
      ...(te.pctPerSet?.length ? { pctPerSet: te.pctPerSet } : {}),
      ...(te.weight != null ? { weight: te.weight } : {}),
      mode: te.mode,
      ...(te.linkedTrainingMaxId
        ? { linkedTo: String(te.linkedTrainingMaxId) }
        : (te as { linkedClientKey?: string }).linkedClientKey
          ? { linkedTo: (te as { linkedClientKey?: string }).linkedClientKey }
          : {}),
    };
  }

  function weekToClient(tw: any, weekPrefix: string): any {
    const days = (tdByWeek.get(String(tw._id)) || []).sort((a: any, b: any) => a.dayIndex - b.dayIndex);
    return {
      id: weekPrefix,
      number: tw.slot,
      _dbIdWeek: String(tw._id),
      days: days.map((td: any, dayIdx: number) => {
        const exercises = (teByDay.get(String(td._id)) || []).sort((a: any, b: any) => a.sortOrder - b.sortOrder);
        return {
          id: `${weekPrefix}-d${dayIdx}`,
          _dbId: String(td._id),
          name: td.name,
          type: td.dayType,
          exercises: exercises.map((te: any, exIdx: number) => exerciseToClient(te, dayIdx, exIdx, weekPrefix)),
        };
      }),
    };
  }

  const clientVersions: any[] = [];
  let latestBaseTemplate: any[] = [];

  for (const v of versions) {
    const weeks = (twByVersion.get(String(v._id)) || []).sort((a: any, b: any) => a.slot - b.slot);
    const templateWeeks: any[] = [];
    for (const tw of weeks) {
      const clientWeek = weekToClient(tw, `template-w${tw.slot}`);
      templateWeeks.push(clientWeek);
    }
    /** Solo plantilla 4 semanas — el cliente materializa w1…w52 en memoria (respuesta HTTP ligera). */
    clientVersions.push({
      effectiveFromWeek: v.effectiveFromWeek,
      weeks: templateWeeks,
    });
    latestBaseTemplate = templateWeeks;
  }

  if (clientVersions.length === 0) {
    return {
      versions: [],
      baseTemplate: [],
      weekTypeOverrides: [] as any[],
      weeks: [] as any[],
    };
  }

  return {
    versions: clientVersions,
    baseTemplate: latestBaseTemplate,
    weekTypeOverrides: [] as any[],
    weeks: [] as any[],
  };
}

/** Lee WorkoutSession/Exercise/Set → logs Record<logKey, LogEntry>. */
export async function assembleRoutineLogs(routineId: mongoose.Types.ObjectId) {
  const sessions = await WorkoutSession.find({ routineId }).lean();
  if (sessions.length === 0) return {};

  const sessionIds = sessions.map((s) => oid(s._id));
  const allWE = await WorkoutExercise.find({ sessionId: { $in: sessionIds } }).lean();
  const weIds = allWE.map((we) => oid(we._id));
  const allWS = await WorkoutSet.find({ workoutExerciseId: { $in: weIds } }).sort({ setIndex: 1 }).lean();

  const setsByExercise = new Map<string, any[]>();
  for (const ws of allWS) {
    const k = String(ws.workoutExerciseId);
    if (!setsByExercise.has(k)) setsByExercise.set(k, []);
    setsByExercise.get(k)!.push(ws);
  }
  const exercisesBySession = new Map<string, any[]>();
  for (const we of allWE) {
    const k = String(we.sessionId);
    if (!exercisesBySession.has(k)) exercisesBySession.set(k, []);
    exercisesBySession.get(k)!.push(we);
  }

  const logs: Record<string, any> = {};
  for (const s of sessions) {
    const exercises = (exercisesBySession.get(String(s._id)) || []).sort((a: any, b: any) => a.exerciseIndex - b.exerciseIndex);
    for (const we of exercises) {
      const logKey = `w${s.planWeek}-d${s.planDayIndex}-e${we.exerciseIndex}`;
      const sets = (setsByExercise.get(String(we._id)) || []).sort((a: any, b: any) => a.setIndex - b.setIndex);
      logs[logKey] = {
        rpe: we.rpe || '',
        notes: we.notes || '',
        completed: !!we.completed,
        ...(we.exerciseWeight != null ? { weight: we.exerciseWeight } : {}),
        sets: sets.map((ws: any) => ({
          id: String(ws.setIndex),
          reps: ws.reps ?? null,
          weight: ws.weight ?? null,
          completed: !!ws.completed,
          ...(ws.inputMode ? { inputMode: ws.inputMode } : {}),
        })),
      };
    }
  }
  return logs;
}

/** Rutina completa para el cliente (plan ligero + logs; sin weeks embebidos legacy en el documento Routine). */
export async function assembleFullRoutine(routine: any) {
  const rid = oid(routine._id ?? routine.id);
  const [plan, logsFromCollections] = await Promise.all([
    assembleRoutinePlan(rid),
    assembleRoutineLogs(rid),
  ]);
  const plain = typeof routine.toObject === 'function' ? routine.toObject() : { ...routine };
  const {
    weeks: _legacyWeeks,
    logs: legacyLogsEmbedded,
    versions: _legacyVersions,
    baseTemplate: _legacyBt,
    weekTypeOverrides: _legacyWto,
    ...meta
  } = plain as Record<string, unknown>;

  const embeddedLogs: Record<string, unknown> =
    legacyLogsEmbedded instanceof Map
      ? Object.fromEntries(legacyLogsEmbedded)
      : legacyLogsEmbedded && typeof legacyLogsEmbedded === 'object'
        ? (legacyLogsEmbedded as Record<string, unknown>)
        : {};

  const mergedLogs = { ...embeddedLogs, ...logsFromCollections };

  const normalizedHasPlan =
    Array.isArray(plan.versions) &&
    plan.versions.length > 0 &&
    Array.isArray((plan.versions[0] as { weeks?: unknown[] }).weeks) &&
    ((plan.versions[0] as { weeks?: unknown[] }).weeks as unknown[]).length > 0;

  if (!normalizedHasPlan) {
    const lv = plain.versions as { effectiveFromWeek?: number; weeks?: unknown[] }[] | undefined;
    const lw = plain.weeks as unknown[] | undefined;
    const lbt = plain.baseTemplate as unknown[] | undefined;
    const hasLegacy =
      (lv?.length && lv[0]?.weeks && (lv[0].weeks as unknown[]).length > 0) ||
      (lw && lw.length > 0) ||
      (lbt && lbt.length > 0);
    if (hasLegacy) {
      return {
        ...meta,
        versions: lv?.length ? lv : [{ effectiveFromWeek: 1, weeks: lw || [] }],
        baseTemplate: lbt || [],
        weekTypeOverrides: (plain as { weekTypeOverrides?: unknown[] }).weekTypeOverrides || [],
        weeks: lw || [],
        logs: mergedLogs,
      };
    }
  }

  return {
    ...meta,
    ...plan,
    logs: mergedLogs,
  };
}

// ---------------------------------------------------------------------------
//  ESCRIBIR: client JSON → colecciones normalizadas
// ---------------------------------------------------------------------------

interface DisassemblePlanInput {
  routineId: mongoose.Types.ObjectId;
  baseTemplate?: any[];
  weekTypeOverrides?: any[];
  versions?: any[];
  /** Longitud del ciclo (1–52). Antes se asumía 4 y se perdían semanas de mesociclos mayores. */
  cycleLength?: number;
}

function inferCycleLengthCl(input: DisassemblePlanInput, rawTemplate: any[]): number {
  if (Number.isFinite(input.cycleLength) && input.cycleLength! >= 1) {
    return Math.max(1, Math.min(52, input.cycleLength!));
  }
  if (rawTemplate.length > 0) {
    const nums = rawTemplate.map((w) => Number(w.number ?? w.slot ?? 1)).filter((n) => Number.isFinite(n) && n >= 1);
    const mx = Math.max(...nums, rawTemplate.length, 1);
    return Math.max(1, Math.min(52, mx));
  }
  return 4;
}

/** Borra el plan viejo y guarda el nuevo en colecciones normalizadas. */
export async function disassemblePlanToCollections(input: DisassemblePlanInput) {
  const { routineId } = input;
  const oldVersions = await ProgramVersion.find({ routineId }).select('_id').lean();
  const oldVIds = oldVersions.map((v) => oid(v._id));
  if (oldVIds.length > 0) {
    const oldTW = await TemplateWeek.find({ programVersionId: { $in: oldVIds } }).select('_id').lean();
    const oldTWIds = oldTW.map((tw) => oid(tw._id));
    if (oldTWIds.length > 0) {
      const oldTD = await TemplateDay.find({ templateWeekId: { $in: oldTWIds } }).select('_id').lean();
      const oldTDIds = oldTD.map((td) => oid(td._id));
      if (oldTDIds.length > 0) {
        await TemplateExercise.deleteMany({ templateDayId: { $in: oldTDIds } });
      }
      await TemplateDay.deleteMany({ templateWeekId: { $in: oldTWIds } });
    }
    await TemplateWeek.deleteMany({ programVersionId: { $in: oldVIds } });
    await ProgramVersion.deleteMany({ routineId });
  }

  const rawTemplate = resolveTemplateSource(input);
  if (rawTemplate.length === 0) return;

  const cl = inferCycleLengthCl(input, rawTemplate);
  const bySlot = new Map<number, any>();
  for (const tpl of rawTemplate) {
    const slot = Math.min(cl, Math.max(1, Number(tpl.number ?? tpl.slot ?? 1)));
    if (!bySlot.has(slot)) bySlot.set(slot, { ...tpl, number: slot });
  }
  const templateSource = Array.from({ length: cl }, (_, i) => {
    const slot = i + 1;
    const w = bySlot.get(slot);
    if (w) return w;
    const fb = bySlot.get(1) ?? rawTemplate[0];
    if (!fb) return { id: `empty-${slot}`, number: slot, days: [] };
    return { ...fb, number: slot, id: fb.id ?? `template-w${slot}` };
  }) as any[];
  if (templateSource.length === 0) return;

  const effectiveVersions = input.versions?.length
    ? input.versions
    : [{ effectiveFromWeek: 1 }];

  
  for (let vi = 0; vi < effectiveVersions.length; vi++) {
    const cv = effectiveVersions[vi];
    const pv = await ProgramVersion.create({
      routineId,
      effectiveFromWeek: cv.effectiveFromWeek ?? 1,
      sortOrder: vi,
    });

    for (const tplWeek of templateSource) {
      const slot = Math.min(cl, Math.max(1, Number(tplWeek.number ?? tplWeek.slot ?? 1)));
      const tw = await TemplateWeek.create({
        programVersionId: pv._id,
        slot,
      });

      const days = Array.isArray(tplWeek.days) ? tplWeek.days : [];
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
            linkedTrainingMaxId: safeLinkedTrainingMaxId(ex),
            linkedClientKey: linkedClientKeyFromExercise(ex),
          });
        }
      }
    }
  }
}

/** Tipo de semana 1–N dentro del ciclo (misma lógica que getMesocycleWeekIndex en el cliente). */
function getWeekType(weekNumber: number, cycleLength: number): number {
  const cl = Math.max(1, Math.min(52, cycleLength));
  return ((Math.max(1, weekNumber) - 1) % cl) + 1;
}

function resolveTemplateSource(input: DisassemblePlanInput): any[] {
  if (Array.isArray(input.baseTemplate) && input.baseTemplate.length > 0) {
    return input.baseTemplate;
  }
  if (Array.isArray(input.versions) && input.versions.length > 0) {
    const latest = input.versions.reduce((a: any, b: any) =>
      (a.effectiveFromWeek ?? 0) >= (b.effectiveFromWeek ?? 0) ? a : b
    );
    const weeks: any[] = latest.weeks || [];
    let clGuess: number;
    if (Number.isFinite(input.cycleLength) && input.cycleLength! >= 1) {
      clGuess = Math.max(1, Math.min(52, input.cycleLength!));
    } else if (weeks.length >= 52) {
      clGuess = 4;
    } else {
      clGuess = Math.max(1, Math.min(52, weeks.length || 4));
    }
    if (weeks.length >= clGuess) {
      const byType: Record<number, any> = {};
      weeks.forEach((w: any) => {
        const type = getWeekType(Number(w.number) || 1, clGuess);
        if (!byType[type]) byType[type] = w;
      });
      return Array.from({ length: clGuess }, (_, i) => {
        const t = i + 1;
        const w = byType[t] || weeks[0];
        return { ...w, number: t };
      });
    }
    return weeks.slice(0, clGuess).map((w: any, i: number) => ({ ...w, number: i + 1 }));
  }
  return [];
}

// ---------------------------------------------------------------------------
//  Logs: client logs → WorkoutSession/Exercise/Set
// ---------------------------------------------------------------------------
const LOG_KEY_RE = /^w(\d+)-d(\d+)-e(\d+)$/;

/** Misma lógica que `parseRoutineLogKeyLoose` en el cliente: clave canónica o sufijo `…-wN-dN-eN`. */
function parseLogKeyForDisassembly(logKey: string): {
  planWeek: number;
  planDayIndex: number;
  exerciseIndex: number;
} | null {
  const exact = LOG_KEY_RE.exec(logKey);
  if (exact) {
    return {
      planWeek: parseInt(exact[1], 10),
      planDayIndex: parseInt(exact[2], 10),
      exerciseIndex: parseInt(exact[3], 10),
    };
  }
  const loose = /w(\d+)-d(\d+)-e(\d+)$/.exec(logKey);
  if (!loose) return null;
  return {
    planWeek: parseInt(loose[1], 10),
    planDayIndex: parseInt(loose[2], 10),
    exerciseIndex: parseInt(loose[3], 10),
  };
}

interface DisassembleLogsInput {
  routineId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  logs: Record<string, any>;
  dateISO?: string;
}

export async function disassembleLogsToCollections(input: DisassembleLogsInput) {
  const { routineId, userId, logs, dateISO } = input;
  const now = dateISO || new Date().toISOString().slice(0, 10);

  const bySession = new Map<string, { planWeek: number; planDayIndex: number; exercises: Map<number, any> }>();
  for (const [logKey, entry] of Object.entries(logs)) {
    if (!entry || typeof entry !== 'object') continue;
    const parsed = parseLogKeyForDisassembly(logKey);
    if (!parsed) continue;
    const { planWeek, planDayIndex, exerciseIndex } = parsed;
    const sessionKey = `${planWeek}-${planDayIndex}`;
    if (!bySession.has(sessionKey)) {
      bySession.set(sessionKey, { planWeek, planDayIndex, exercises: new Map() });
    }
    bySession.get(sessionKey)!.exercises.set(exerciseIndex, entry);
  }

  for (const [, info] of bySession) {
    let session = await WorkoutSession.findOne({
      routineId,
      planWeek: info.planWeek,
      planDayIndex: info.planDayIndex,
    });
    if (!session) {
      session = await WorkoutSession.create({
        userId,
        routineId,
        dateISO: now,
        planWeek: info.planWeek,
        planDayIndex: info.planDayIndex,
      });
    } else if (session.dateISO !== now) {
      session.dateISO = now;
      await session.save();
    }

    for (const [exerciseIndex, entry] of info.exercises) {
      let we = await WorkoutExercise.findOne({ sessionId: session._id, exerciseIndex });
      if (!we) {
        we = await WorkoutExercise.create({
          sessionId: session._id,
          exerciseName: (entry.exerciseName && String(entry.exerciseName).trim()) || 'Ejercicio',
          exerciseIndex,
          notes: entry.notes ?? '',
          rpe: entry.rpe ?? '',
          completed: !!entry.completed,
          exerciseWeight: entry.weight ?? undefined,
        });
      } else {
        if (entry.exerciseName != null && String(entry.exerciseName).trim()) {
          we.exerciseName = String(entry.exerciseName).trim();
        }
        we.notes = entry.notes ?? '';
        we.rpe = entry.rpe ?? '';
        we.completed = !!entry.completed;
        if (entry.weight != null) we.exerciseWeight = entry.weight;
        await we.save();
      }

      const sets = Array.isArray(entry.sets) ? entry.sets : [];
      await WorkoutSet.deleteMany({ workoutExerciseId: we._id });
      if (sets.length > 0) {
        await WorkoutSet.insertMany(
          sets.map((s: any, si: number) => ({
            workoutExerciseId: we!._id,
            setIndex: si,
            reps: s.reps != null && s.reps !== '' ? Number(s.reps) : undefined,
            weight: s.weight != null && s.weight !== '' ? Number(s.weight) : undefined,
            completed: !!s.completed,
            rpe: s.rpe ?? '',
            inputMode: s.inputMode === 'kg' || s.inputMode === 'pct' ? s.inputMode : undefined,
          }))
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
//  HistoryEntry: TM snapshot normalizado
// ---------------------------------------------------------------------------
export async function saveHistoryTmSnapshots(
  historyEntryId: mongoose.Types.ObjectId,
  trainingMaxes: Record<string, number>
) {
  const ops: any[] = [];
  for (const [tmId, value] of Object.entries(trainingMaxes)) {
    if (!mongoose.Types.ObjectId.isValid(tmId)) continue;
    ops.push({
      updateOne: {
        filter: { historyEntryId, trainingMaxId: oid(tmId) },
        update: { $set: { historyEntryId, trainingMaxId: oid(tmId), value: Number(value) } },
        upsert: true,
      },
    });
  }
  if (ops.length > 0) {
    await HistoryTmSnapshot.bulkWrite(ops);
  }
}

export async function loadHistoryTmSnapshotsAsRecord(historyEntryId: mongoose.Types.ObjectId): Promise<Record<string, number>> {
  const docs = await HistoryTmSnapshot.find({ historyEntryId }).lean();
  const out: Record<string, number> = {};
  for (const d of docs) {
    out[String(d.trainingMaxId)] = d.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Tras cambiar la plantilla (PATCH /plan): borrar logs/series de ejercicios que ya no existen
// ---------------------------------------------------------------------------

function weekTypeSlotFromPlanWeek(planWeek: number): number {
  return ((Math.max(1, planWeek) - 1) % 4) + 1;
}

async function programVersionForPlanWeek(
  routineId: mongoose.Types.ObjectId,
  planWeek: number
): Promise<{ _id: mongoose.Types.ObjectId; effectiveFromWeek?: number } | null> {
  const versions = await ProgramVersion.find({ routineId }).sort({ effectiveFromWeek: 1 }).lean();
  if (!versions.length) return null;
  let chosen = versions[0];
  for (const v of versions) {
    if ((v.effectiveFromWeek ?? 1) <= planWeek) chosen = v;
  }
  return chosen as { _id: mongoose.Types.ObjectId; effectiveFromWeek?: number };
}

/** Número de ejercicios en plantilla para (semana del plan, día 0–6). */
export async function getExpectedExerciseCountForSession(
  routineId: mongoose.Types.ObjectId,
  planWeek: number,
  planDayIndex: number
): Promise<number> {
  const pv = await programVersionForPlanWeek(routineId, planWeek);
  if (!pv) return 0;
  const slot = weekTypeSlotFromPlanWeek(planWeek);
  const tw = await TemplateWeek.findOne({ programVersionId: oid(pv._id), slot }).lean();
  if (!tw) return 0;
  const td = await TemplateDay.findOne({ templateWeekId: oid(tw._id), dayIndex: planDayIndex }).lean();
  if (!td) return 0;
  return TemplateExercise.countDocuments({ templateDayId: oid(td._id) });
}

/**
 * Elimina WorkoutExercise/WorkoutSet y ExerciseLog cuyo índice de ejercicio ya no existe en la plantilla nueva.
 * Debe llamarse después de `disassemblePlanToCollections` (p. ej. PATCH /plan).
 */
export async function pruneWorkoutDataAfterPlanChange(routineId: mongoose.Types.ObjectId): Promise<void> {
  const sessions = await WorkoutSession.find({ routineId }).select('_id planWeek planDayIndex').lean();
  for (const s of sessions) {
    const expected = await getExpectedExerciseCountForSession(routineId, s.planWeek, s.planDayIndex);
    const wes = await WorkoutExercise.find({ sessionId: oid(s._id) })
      .select('_id exerciseIndex')
      .lean();
    const toRemove = wes.filter((we) => we.exerciseIndex > expected);
    if (toRemove.length === 0) continue;
    const ids = toRemove.map((w) => oid(w._id));
    await WorkoutSet.deleteMany({ workoutExerciseId: { $in: ids } });
    await WorkoutExercise.deleteMany({ _id: { $in: ids } });
  }

  const logDocs = await ExerciseLog.find({ routineId }).select('_id logKey').lean();
  for (const doc of logDocs) {
    const parsed = parseLogKeyForDisassembly(doc.logKey);
    if (!parsed) continue;
    const exp = await getExpectedExerciseCountForSession(
      routineId,
      parsed.planWeek,
      parsed.planDayIndex
    );
    if (parsed.exerciseIndex > exp) {
      await ExerciseLog.deleteOne({ _id: doc._id });
    }
  }
}

// ---------------------------------------------------------------------------
//  Cascada: eliminar todo lo de una rutina
// ---------------------------------------------------------------------------
export async function deleteRoutineCascade(routineId: mongoose.Types.ObjectId) {
  const versionIds = (await ProgramVersion.find({ routineId }).select('_id').lean()).map((v) => oid(v._id));
  if (versionIds.length > 0) {
    const twIds = (await TemplateWeek.find({ programVersionId: { $in: versionIds } }).select('_id').lean()).map((tw) => oid(tw._id));
    if (twIds.length > 0) {
      const tdIds = (await TemplateDay.find({ templateWeekId: { $in: twIds } }).select('_id').lean()).map((td) => oid(td._id));
      if (tdIds.length > 0) await TemplateExercise.deleteMany({ templateDayId: { $in: tdIds } });
      await TemplateDay.deleteMany({ templateWeekId: { $in: twIds } });
    }
    await TemplateWeek.deleteMany({ programVersionId: { $in: versionIds } });
    await ProgramVersion.deleteMany({ routineId });
  }
  const sessionIds = (await WorkoutSession.find({ routineId }).select('_id').lean()).map((s) => oid(s._id));
  if (sessionIds.length > 0) {
    const weIds = (await WorkoutExercise.find({ sessionId: { $in: sessionIds } }).select('_id').lean()).map((we) => oid(we._id));
    if (weIds.length > 0) await WorkoutSet.deleteMany({ workoutExerciseId: { $in: weIds } });
    await WorkoutExercise.deleteMany({ sessionId: { $in: sessionIds } });
    await WorkoutSession.deleteMany({ routineId });
  }
  await InternalExerciseMax.deleteMany({ routineId });
  await ExerciseLog.deleteMany({ routineId });
}
