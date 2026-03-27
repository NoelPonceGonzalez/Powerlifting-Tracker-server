import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth';
import { Routine } from '../models/Routine';
import { TrainingMax } from '../models/TrainingMax';
import { HistoryEntry } from '../models/HistoryEntry';
import { HistoryTmSnapshot } from '../models/HistoryTmSnapshot';
import { ProgramVersion } from '../models/ProgramVersion';
import { TemplateWeek } from '../models/TemplateWeek';
import { TemplateDay } from '../models/TemplateDay';
import { TemplateExercise } from '../models/TemplateExercise';
import { WorkoutSession } from '../models/WorkoutSession';
import { WorkoutExercise } from '../models/WorkoutExercise';
import { WorkoutSet } from '../models/WorkoutSet';
import { body, validationResult } from 'express-validator';
import {
  assembleFullRoutine,
  assembleRoutinePlan,
  assembleRoutineLogs,
  disassemblePlanToCollections,
  disassembleLogsToCollections,
  deleteRoutineCascade,
  pruneWorkoutDataAfterPlanChange,
} from '../utils/assembleRoutine';

const router = express.Router();
const oid = (v: any) =>
  v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v));

// GET /api/routines
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const routines = await Routine.find({ userId }).sort({ createdAt: -1 }).lean();
    const out = await Promise.all(routines.map((r) => assembleFullRoutine(r)));
    res.json(out);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/routines
router.post(
  '/',
  authenticateToken,
  [body('name').trim().notEmpty().withMessage('El nombre es requerido')],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const userId = (req as any).user.userId;
      const uid = oid(userId);
      const { name, weeks, baseTemplate, weekTypeOverrides, versions } = req.body;

      const existingRoutines = await Routine.countDocuments({ userId });
      const isActive = existingRoutines === 0 || req.body.isActive === true;
      if (isActive) await Routine.updateMany({ userId }, { isActive: false });

      const routine = await Routine.create({
        userId,
        name,
        isActive,
        sameTemplateAllWeeks: req.body.sameTemplateAllWeeks !== false,
        hiddenFromSocial: !!req.body.hiddenFromSocial,
      });

      const rid = oid(routine._id);
      await disassemblePlanToCollections({
        routineId: rid,
        baseTemplate,
        weekTypeOverrides,
        versions: versions || (Array.isArray(weeks) && weeks.length > 0 ? [{ effectiveFromWeek: 1, weeks }] : undefined),
      });
      await pruneWorkoutDataAfterPlanChange(rid);

      const assembled = await assembleFullRoutine(routine);
      res.status(201).json(assembled);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// PATCH /api/routines/:id/plan  (bulk — kept as fallback)
router.patch('/:id/plan', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const routine = await Routine.findOne({ _id: req.params.id, userId });
    if (!routine) return res.status(404).json({ error: 'Rutina no encontrada' });

    const { baseTemplate, weekTypeOverrides, versions, sameTemplateAllWeeks, hiddenFromSocial } = req.body;

    if (sameTemplateAllWeeks !== undefined) routine.sameTemplateAllWeeks = !!sameTemplateAllWeeks;
    if (hiddenFromSocial !== undefined) routine.hiddenFromSocial = !!hiddenFromSocial;
    await routine.save();

    const rid = oid(routine._id);
    const hasTemplateData =
      (Array.isArray(baseTemplate) && baseTemplate.length > 0) ||
      (Array.isArray(versions) && versions.length > 0);

    if (hasTemplateData) {
      await disassemblePlanToCollections({ routineId: rid, baseTemplate, weekTypeOverrides, versions });
      await pruneWorkoutDataAfterPlanChange(rid);
    }

    /** Devuelve la rutina ensamblada para que el cliente actualice estado y _dbId sin otro GET. */
    res.json(await assembleFullRoutine(routine));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
//  Granular template endpoints — modify a single column, not the whole plan
// ---------------------------------------------------------------------------

/** Given a TemplateExercise, find all sibling exercises (same slot+dayIndex+sortOrder) across all ProgramVersions of the same routine. */
async function findSiblingExerciseIds(te: any): Promise<mongoose.Types.ObjectId[]> {
  const td = await TemplateDay.findById(te.templateDayId).lean();
  if (!td) return [oid(te._id)];
  const tw = await TemplateWeek.findById(td.templateWeekId).lean();
  if (!tw) return [oid(te._id)];
  const pv = await ProgramVersion.findById(tw.programVersionId).lean();
  if (!pv) return [oid(te._id)];

  const allPVs = await ProgramVersion.find({ routineId: pv.routineId }).select('_id').lean();
  const pvIds = allPVs.map((v) => oid(v._id));
  const matchingTWs = await TemplateWeek.find({ programVersionId: { $in: pvIds }, slot: tw.slot }).select('_id').lean();
  const twIds = matchingTWs.map((w) => oid(w._id));
  const matchingTDs = await TemplateDay.find({ templateWeekId: { $in: twIds }, dayIndex: td.dayIndex }).select('_id').lean();
  const tdIds = matchingTDs.map((d) => oid(d._id));
  const siblings = await TemplateExercise.find({ templateDayId: { $in: tdIds }, sortOrder: te.sortOrder }).select('_id').lean();
  return siblings.map((s) => oid(s._id));
}

/** Find all sibling TemplateDay IDs (same slot+dayIndex) across all versions. */
async function findSiblingDayIds(td: any): Promise<mongoose.Types.ObjectId[]> {
  const tw = await TemplateWeek.findById(td.templateWeekId).lean();
  if (!tw) return [oid(td._id)];
  const pv = await ProgramVersion.findById(tw.programVersionId).lean();
  if (!pv) return [oid(td._id)];

  const allPVs = await ProgramVersion.find({ routineId: pv.routineId }).select('_id').lean();
  const pvIds = allPVs.map((v) => oid(v._id));
  const matchingTWs = await TemplateWeek.find({ programVersionId: { $in: pvIds }, slot: tw.slot }).select('_id').lean();
  const twIds = matchingTWs.map((w) => oid(w._id));
  const siblings = await TemplateDay.find({ templateWeekId: { $in: twIds }, dayIndex: td.dayIndex }).select('_id').lean();
  return siblings.map((d) => oid(d._id));
}

function safeLinkedTrainingMaxId(linkedTo?: string): mongoose.Types.ObjectId | undefined {
  if (!linkedTo) return undefined;
  const s = String(linkedTo).trim();
  if (!/^[a-fA-F0-9]{24}$/.test(s)) return undefined;
  try { return new mongoose.Types.ObjectId(s); } catch { return undefined; }
}

// PATCH /api/routines/:id/exercises/:exId  — update one exercise (sets, reps, name…)
router.patch('/:id/exercises/:exId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const routine = await Routine.findOne({ _id: req.params.id, userId });
    if (!routine) return res.status(404).json({ error: 'Rutina no encontrada' });

    const te = await TemplateExercise.findById(req.params.exId);
    if (!te) return res.status(404).json({ error: 'Ejercicio no encontrado' });

    const { name, sets, reps, pct, pctPerSet, weight, mode, linkedTo } = req.body;
    const $set: Record<string, any> = {};
    if (name !== undefined) $set.exerciseName = name;
    if (sets !== undefined) $set.sets = sets;
    if (reps !== undefined) {
      if (typeof reps === 'number') { $set.repsInt = reps; $set.repsText = undefined; }
      else { $set.repsText = String(reps); $set.repsInt = undefined; }
    }
    if (pct !== undefined) $set.pct = pct;
    if (pctPerSet !== undefined) $set.pctPerSet = pctPerSet;
    if (weight !== undefined) $set.weight = weight;
    if (mode !== undefined) $set.mode = mode;
    if (linkedTo !== undefined) {
      const tmOid = safeLinkedTrainingMaxId(linkedTo);
      $set.linkedTrainingMaxId = tmOid || undefined;
      $set.linkedClientKey = tmOid ? undefined : (linkedTo || undefined);
    }

    if (Object.keys($set).length === 0) return res.json({ ok: true, updated: 0 });

    const siblingIds = await findSiblingExerciseIds(te);
    const result = await TemplateExercise.updateMany({ _id: { $in: siblingIds } }, { $set });
    const fresh = await TemplateExercise.findById(te._id).lean();
    const repsOut =
      fresh?.repsInt != null ? fresh.repsInt : fresh?.repsText ?? '';
    const exercisePayload = fresh
      ? {
          sets: fresh.sets,
          reps: repsOut,
          ...(fresh.pct != null ? { pct: fresh.pct } : {}),
          ...(fresh.pctPerSet?.length ? { pctPerSet: fresh.pctPerSet } : {}),
          ...(fresh.weight != null ? { weight: fresh.weight } : {}),
          mode: fresh.mode,
        }
      : undefined;
    res.json({ ok: true, updated: result.modifiedCount, ...(exercisePayload ? { exercise: exercisePayload } : {}) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/routines/:id/exercises/:exId  — remove one exercise
router.delete('/:id/exercises/:exId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const routine = await Routine.findOne({ _id: req.params.id, userId });
    if (!routine) return res.status(404).json({ error: 'Rutina no encontrada' });

    const te = await TemplateExercise.findById(req.params.exId).lean();
    if (!te) return res.status(404).json({ error: 'Ejercicio no encontrado' });

    const td = await TemplateDay.findById(te.templateDayId).lean();
    const deletedExIndex = te.sortOrder + 1; // exerciseIndex is 1-based

    const siblingIds = await findSiblingExerciseIds(te);
    await TemplateExercise.deleteMany({ _id: { $in: siblingIds } });

    // Re-sort remaining exercises in each affected day
    if (td) {
      const dayIds = await findSiblingDayIds(td);
      for (const dayId of dayIds) {
        const remaining = await TemplateExercise.find({ templateDayId: dayId }).sort({ sortOrder: 1 });
        for (let i = 0; i < remaining.length; i++) {
          if (remaining[i].sortOrder !== i) {
            remaining[i].sortOrder = i;
            await remaining[i].save();
          }
        }
      }
    }

    // Cascade: delete WorkoutExercise/WorkoutSet for the removed exercise and reindex
    const routineId = oid(routine._id);
    const dayIndex = td?.dayIndex;
    if (dayIndex != null) {
      const sessions = await WorkoutSession.find({ routineId, planDayIndex: dayIndex }).select('_id').lean();
      const sessionIds = sessions.map((s) => oid(s._id));
      if (sessionIds.length > 0) {
        const toDelete = await WorkoutExercise.find({
          sessionId: { $in: sessionIds },
          exerciseIndex: deletedExIndex,
        }).select('_id').lean();
        const toDeleteIds = toDelete.map((d) => oid(d._id));
        if (toDeleteIds.length > 0) {
          await WorkoutSet.deleteMany({ workoutExerciseId: { $in: toDeleteIds } });
          await WorkoutExercise.deleteMany({ _id: { $in: toDeleteIds } });
        }
        // Reindex remaining exercises with higher index
        await WorkoutExercise.updateMany(
          { sessionId: { $in: sessionIds }, exerciseIndex: { $gt: deletedExIndex } },
          { $inc: { exerciseIndex: -1 } }
        );
      }
    }

    res.json({ ok: true, deleted: siblingIds.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/routines/:id/days/:dayId/exercises  — add one exercise to a day
router.post('/:id/days/:dayId/exercises', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const routine = await Routine.findOne({ _id: req.params.id, userId });
    if (!routine) return res.status(404).json({ error: 'Rutina no encontrada' });

    const td = await TemplateDay.findById(req.params.dayId).lean();
    if (!td) return res.status(404).json({ error: 'Día no encontrado' });

    const { name, sets, reps, pct, pctPerSet, mode, linkedTo } = req.body;
    const maxSort = await TemplateExercise.findOne({ templateDayId: td._id }).sort({ sortOrder: -1 }).lean();
    const sortOrder = (maxSort?.sortOrder ?? -1) + 1;

    const tmOid = safeLinkedTrainingMaxId(linkedTo);
    const exerciseData = {
      sortOrder,
      exerciseName: name || 'Nuevo Ejercicio',
      sets: sets || 3,
      repsInt: typeof reps === 'number' ? reps : undefined,
      repsText: typeof reps === 'string' ? reps : undefined,
      pct: pct,
      pctPerSet: Array.isArray(pctPerSet) ? pctPerSet : undefined,
      mode: mode || 'weight',
      linkedTrainingMaxId: tmOid,
      linkedClientKey: tmOid ? undefined : (linkedTo || undefined),
    };

    const siblingDayIds = await findSiblingDayIds(td);
    const created: any[] = [];
    for (const dayId of siblingDayIds) {
      const doc = await TemplateExercise.create({ ...exerciseData, templateDayId: dayId });
      created.push({ _dbId: String(doc._id), templateDayId: String(dayId) });
    }

    res.status(201).json({ ok: true, created });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/routines/:id/days/:dayId  — update day type
router.patch('/:id/days/:dayId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const routine = await Routine.findOne({ _id: req.params.id, userId });
    if (!routine) return res.status(404).json({ error: 'Rutina no encontrada' });

    const td = await TemplateDay.findById(req.params.dayId);
    if (!td) return res.status(404).json({ error: 'Día no encontrado' });

    const { dayType, name } = req.body;
    const $set: Record<string, any> = {};
    if (dayType !== undefined) $set.dayType = dayType;
    if (name !== undefined) $set.name = name;

    if (Object.keys($set).length === 0) return res.json({ ok: true, updated: 0 });

    const siblingDayIds = await findSiblingDayIds(td);
    const result = await TemplateDay.updateMany({ _id: { $in: siblingDayIds } }, { $set });
    res.json({ ok: true, updated: result.modifiedCount });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/routines/:id/logs
router.patch('/:id/logs', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const { logs, dateISO } = req.body;
    if (!logs || typeof logs !== 'object') return res.json({ ok: true });

    const routine = await Routine.findOne({ _id: req.params.id, userId });
    if (!routine) return res.status(404).json({ error: 'Rutina no encontrada' });

    await disassembleLogsToCollections({
      routineId: oid(routine._id),
      userId: oid(userId),
      logs,
      dateISO,
    });
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/routines/:id/activate
router.put('/:id/activate', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    await Routine.updateMany({ userId }, { isActive: false });
    const routine = await Routine.findOneAndUpdate(
      { _id: req.params.id, userId },
      { isActive: true },
      { new: true }
    );
    if (!routine) return res.status(404).json({ error: 'Rutina no encontrada' });
    res.json(await assembleFullRoutine(routine));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/routines/:id
router.get('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const routine = await Routine.findOne({ _id: req.params.id, userId });
    if (!routine) return res.status(404).json({ error: 'Rutina no encontrada' });
    res.json(await assembleFullRoutine(routine));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/routines/:id
router.put(
  '/:id',
  authenticateToken,
  [body('name').optional().trim().notEmpty().withMessage('El nombre no puede estar vacío')],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const userId = (req as any).user.userId;
      const uid = oid(userId);
      const { name, baseTemplate, weekTypeOverrides, versions, weeks, logs, isActive, sameTemplateAllWeeks, hiddenFromSocial } = req.body;

      const routine = await Routine.findOne({ _id: req.params.id, userId });
      if (!routine) return res.status(404).json({ error: 'Rutina no encontrada' });

      if (name !== undefined) routine.name = name;
      if (sameTemplateAllWeeks !== undefined) routine.sameTemplateAllWeeks = !!sameTemplateAllWeeks;
      if (hiddenFromSocial !== undefined) routine.hiddenFromSocial = !!hiddenFromSocial;

      if (isActive === true) {
        await Routine.updateMany({ userId, _id: { $ne: req.params.id } }, { isActive: false });
        routine.isActive = true;
      } else if (isActive === false) {
        routine.isActive = false;
      }
      await routine.save();

      const rid = oid(routine._id);
      const hasTemplateData =
        (Array.isArray(baseTemplate) && baseTemplate.length > 0) ||
        (Array.isArray(versions) && versions.length > 0) ||
        (Array.isArray(weeks) && weeks.length > 0);

      if (hasTemplateData) {
        await disassemblePlanToCollections({
          routineId: rid,
          baseTemplate,
          weekTypeOverrides,
          versions: versions || (Array.isArray(weeks) && weeks.length > 0 ? [{ effectiveFromWeek: 1, weeks }] : undefined),
        });
        await pruneWorkoutDataAfterPlanChange(rid);
      }

      if (logs !== undefined && typeof logs === 'object') {
        await disassembleLogsToCollections({ routineId: rid, userId: uid, logs });
      }

      res.json(await assembleFullRoutine(routine));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// DELETE /api/routines/:id
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const routine = await Routine.findOneAndDelete({ _id: req.params.id, userId });
    if (!routine) return res.status(404).json({ error: 'Rutina no encontrada' });
    const rid = oid(routine._id);
    await deleteRoutineCascade(rid);
    await TrainingMax.deleteMany({ userId, routineId: rid });
    const heIds = (await HistoryEntry.find({ userId, routineId: rid }).select('_id').lean()).map((h) => oid(h._id));
    if (heIds.length > 0) await HistoryTmSnapshot.deleteMany({ historyEntryId: { $in: heIds } });
    await HistoryEntry.deleteMany({ userId, routineId: rid });
    res.json({ message: 'Rutina eliminada' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
