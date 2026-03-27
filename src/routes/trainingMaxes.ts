import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth';
import { TrainingMax } from '../models/TrainingMax';
import { Routine } from '../models/Routine';
import { HistoryEntry } from '../models/HistoryEntry';
import { body, query, validationResult } from 'express-validator';
import { calendarMonth1FromDateISO, dateISOFromYearWeekDay } from '../utils/calendarWeekDate';
import { HistoryTmSnapshot } from '../models/HistoryTmSnapshot';
import { saveHistoryTmSnapshots, loadHistoryTmSnapshotsAsRecord } from '../utils/assembleRoutine';

const router = express.Router();

/** Fecha enviada por el cliente (día del plan en Rutina); rechaza futuro absurdo. */
function parseOptionalClientDate(raw: unknown): Date | null {
  if (raw == null || typeof raw !== 'string' || !raw.trim()) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const maxFuture = Date.now() + 48 * 60 * 60 * 1000;
  if (d.getTime() > maxFuture) return null;
  return d;
}

/** Asigna TM antiguos (sin rutina) a la rutina activa del usuario — migración única. */
async function migrateLegacyTrainingMaxes(userId: mongoose.Types.ObjectId) {
  const orphanCount = await TrainingMax.countDocuments({
    userId,
    $or: [{ routineId: { $exists: false } }, { routineId: null }],
  });
  if (orphanCount === 0) return;
  const activeRoutine = await Routine.findOne({ userId, isActive: true });
  if (!activeRoutine) return;
  await TrainingMax.updateMany(
    { userId, $or: [{ routineId: { $exists: false } }, { routineId: null }] },
    { $set: { routineId: activeRoutine._id } }
  );
}

async function assertRoutineOwned(userId: mongoose.Types.ObjectId, routineId: string) {
  const routine = await Routine.findOne({ _id: routineId, userId });
  return routine;
}

/** Entradas de historial sin rutina → rutina activa (migración). */
async function migrateLegacyHistoryEntries(userId: mongoose.Types.ObjectId) {
  const orphanCount = await HistoryEntry.countDocuments({
    userId,
    $or: [{ routineId: { $exists: false } }, { routineId: null }],
  });
  if (orphanCount === 0) return;
  const activeRoutine = await Routine.findOne({ userId, isActive: true });
  if (!activeRoutine) return;
  await HistoryEntry.updateMany(
    { userId, $or: [{ routineId: { $exists: false } }, { routineId: null }] },
    { $set: { routineId: activeRoutine._id } }
  );
}

// GET /api/training-maxes?routineId= — Training Maxes de una rutina concreta
router.get(
  '/',
  authenticateToken,
  [query('routineId').isMongoId().withMessage('routineId inválido')],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = new mongoose.Types.ObjectId((req as any).user.userId);
      await migrateLegacyTrainingMaxes(userId);

      const routineId = String(req.query.routineId);
      const routine = await assertRoutineOwned(userId, routineId);
      if (!routine) {
        return res.status(404).json({ error: 'Rutina no encontrada' });
      }

      const rid = routine._id instanceof mongoose.Types.ObjectId ? routine._id : new mongoose.Types.ObjectId(String(routine._id));
      const trainingMaxes = await TrainingMax.find({ userId, routineId: rid }).sort({ createdAt: 1 });
      res.json(trainingMaxes);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// POST /api/training-maxes - Crear un nuevo Training Max (vinculado a una rutina)
router.post(
  '/',
  authenticateToken,
  [
    body('routineId').isMongoId().withMessage('routineId inválido'),
    body('name').trim().notEmpty().withMessage('El nombre es requerido'),
    body('value').isNumeric().withMessage('El valor debe ser numérico'),
    body('mode').isIn(['weight', 'reps', 'seconds']).withMessage('Modo inválido'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = new mongoose.Types.ObjectId((req as any).user.userId);
      const { name, value, mode, linkedExercise, sharedToSocial, routineId } = req.body;

      const routine = await assertRoutineOwned(userId, routineId);
      if (!routine) {
        return res.status(404).json({ error: 'Rutina no encontrada' });
      }

      const trainingMax = new TrainingMax({
        userId,
        routineId: routine._id,
        name,
        value,
        mode,
        linkedExercise,
        sharedToSocial: !!sharedToSocial,
      });
      await trainingMax.save();
      const createdAtClient = parseOptionalClientDate(req.body.createdAt);
      if (createdAtClient) {
        await TrainingMax.collection.updateOne(
          { _id: trainingMax._id },
          { $set: { createdAt: createdAtClient, updatedAt: createdAtClient } }
        );
      }
      const out = await TrainingMax.findById(trainingMax._id);
      res.status(201).json(out ?? trainingMax);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// PUT /api/training-maxes/:id - Actualizar un TM (debe pertenecer a `routineId`; no basta con userId)
router.put(
  '/:id',
  authenticateToken,
  [
    body('routineId').isMongoId().withMessage('routineId inválido'),
    body('value').optional().isNumeric().withMessage('El valor debe ser numérico'),
    body('name').optional().trim().notEmpty().withMessage('El nombre no puede estar vacío'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = new mongoose.Types.ObjectId((req as any).user.userId);
      const { name, value, mode, linkedExercise, sharedToSocial, routineId } = req.body;

      const routine = await assertRoutineOwned(userId, routineId);
      if (!routine) {
        return res.status(404).json({ error: 'Rutina no encontrada' });
      }
      const rid =
        routine._id instanceof mongoose.Types.ObjectId
          ? routine._id
          : new mongoose.Types.ObjectId(String(routine._id));

      const trainingMax = await TrainingMax.findOne({ _id: req.params.id, userId, routineId: rid });
      if (!trainingMax) {
        return res.status(404).json({ error: 'Training Max no encontrado en esta rutina' });
      }

      const $set: Record<string, unknown> = {};
      if (name !== undefined) $set.name = name;
      if (value !== undefined) $set.value = value;
      if (mode !== undefined) $set.mode = mode;
      if (linkedExercise !== undefined) $set.linkedExercise = linkedExercise;
      if (sharedToSocial !== undefined) $set.sharedToSocial = !!sharedToSocial;

      const updatedAtClient = parseOptionalClientDate(req.body.updatedAt);
      $set.updatedAt = updatedAtClient ?? new Date();

      const updated = await TrainingMax.findOneAndUpdate(
        { _id: req.params.id, userId, routineId: rid },
        { $set },
        { new: true, runValidators: true, timestamps: false }
      );
      if (!updated) {
        return res.status(404).json({ error: 'Training Max no encontrado en esta rutina' });
      }
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// DELETE /api/training-maxes/:id?routineId= — Eliminar un TM de esa rutina
router.delete(
  '/:id',
  authenticateToken,
  [query('routineId').isMongoId().withMessage('routineId inválido')],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = new mongoose.Types.ObjectId((req as any).user.userId);
      const routineId = String(req.query.routineId);
      const routine = await assertRoutineOwned(userId, routineId);
      if (!routine) {
        return res.status(404).json({ error: 'Rutina no encontrada' });
      }
      const rid =
        routine._id instanceof mongoose.Types.ObjectId
          ? routine._id
          : new mongoose.Types.ObjectId(String(routine._id));

      const trainingMax = await TrainingMax.findOneAndDelete({ _id: req.params.id, userId, routineId: rid });
      if (!trainingMax) {
        return res.status(404).json({ error: 'Training Max no encontrado en esta rutina' });
      }
      await HistoryTmSnapshot.deleteMany({ trainingMaxId: trainingMax._id });
      res.json({ message: 'Training Max eliminado' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// POST /api/training-maxes/save-period - Guardar el período actual (historial mensual, por rutina)
router.post(
  '/save-period',
  authenticateToken,
  [
    body('routineId').isMongoId().withMessage('routineId inválido'),
    body('date').notEmpty().withMessage('La fecha es requerida'),
    body('rms').isObject().withMessage('Los RMs deben ser un objeto'),
    body('total').isNumeric().withMessage('El total debe ser numérico'),
    body('trainingMaxes').isObject().withMessage('Los Training Maxes deben ser un objeto'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = new mongoose.Types.ObjectId((req as any).user.userId);
      const { date, week, year, rms, total, trainingMaxes, routineId, progressKind, dayOfWeek } = req.body;
      let dateISO: string | undefined =
        typeof req.body.dateISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.dateISO)
          ? req.body.dateISO
          : undefined;
      let monthNum: number | undefined =
        typeof req.body.month === 'number' && req.body.month >= 1 && req.body.month <= 12
          ? req.body.month
          : undefined;

      const routine = await assertRoutineOwned(userId, routineId);
      if (!routine) {
        return res.status(404).json({ error: 'Rutina no encontrada' });
      }
      const rid = routine._id instanceof mongoose.Types.ObjectId ? routine._id : new mongoose.Types.ObjectId(String(routine._id));

      const y = year != null ? Number(year) : undefined;
      const w = week != null ? Number(week) : undefined;
      const d = typeof dayOfWeek === 'number' && !Number.isNaN(dayOfWeek) ? Number(dayOfWeek) : undefined;
      if (!dateISO && y != null && w != null) {
        dateISO = dateISOFromYearWeekDay(y, w, d ?? 0);
      }
      if (monthNum == null && dateISO) {
        monthNum = calendarMonth1FromDateISO(dateISO);
      }

      const query: any = { userId, routineId: rid };
      if (week != null && year != null) {
        query.year = Number(year);
        query.week = Number(week);
        const d = dayOfWeek;
        if (typeof d === 'number' && !Number.isNaN(d)) {
          query.dayOfWeek = Number(d);
        } else {
          query.$or = [{ dayOfWeek: { $exists: false } }, { dayOfWeek: null }];
        }
      } else {
        query.date = date;
      }
      const existing = await HistoryEntry.findOne(query);

      const rmsBench = typeof rms?.bench === 'number' ? rms.bench : undefined;
      const rmsSquat = typeof rms?.squat === 'number' ? rms.squat : undefined;
      const rmsDeadlift = typeof rms?.deadlift === 'number' ? rms.deadlift : undefined;

      if (existing) {
        existing.total = total;
        if (progressKind !== undefined) (existing as any).progressKind = progressKind;
        if (week !== undefined) (existing as any).planWeek = Number(week);
        if (year !== undefined) existing.year = Number(year);
        if (typeof dayOfWeek === 'number' && !Number.isNaN(dayOfWeek)) {
          existing.dayOfWeek = Number(dayOfWeek);
        }
        if (dateISO) existing.dateISO = dateISO;
        if (monthNum != null) existing.month = monthNum;
        if (rmsBench != null) (existing as any).benchRm = rmsBench;
        if (rmsSquat != null) (existing as any).squatRm = rmsSquat;
        if (rmsDeadlift != null) (existing as any).deadliftRm = rmsDeadlift;
        existing.routineId = rid;
        (existing as any).dateLabel = date;
        await existing.save();
        const heId = existing._id instanceof mongoose.Types.ObjectId ? existing._id : new mongoose.Types.ObjectId(String(existing._id));
        if (trainingMaxes && typeof trainingMaxes === 'object') {
          await saveHistoryTmSnapshots(heId, trainingMaxes);
        }
        const tmSnap = await loadHistoryTmSnapshotsAsRecord(heId);
        res.json({ ...existing.toObject(), trainingMaxes: tmSnap, rms: { bench: (existing as any).benchRm ?? 0, squat: (existing as any).squatRm ?? 0, deadlift: (existing as any).deadliftRm ?? 0 } });
      } else {
        if (!dateISO) dateISO = new Date().toISOString().slice(0, 10);
        if (monthNum == null) monthNum = calendarMonth1FromDateISO(dateISO);
        const historyEntry = new HistoryEntry({
          userId,
          routineId: rid,
          dateLabel: date,
          dateISO,
          year: year != null ? Number(year) : new Date().getFullYear(),
          month: monthNum!,
          planWeek: week != null ? Number(week) : undefined,
          ...(typeof dayOfWeek === 'number' && !Number.isNaN(dayOfWeek) ? { dayOfWeek: Number(dayOfWeek) } : {}),
          total,
          ...(progressKind ? { progressKind } : {}),
          benchRm: rmsBench,
          squatRm: rmsSquat,
          deadliftRm: rmsDeadlift,
        });
        await historyEntry.save();
        const heId = historyEntry._id instanceof mongoose.Types.ObjectId ? historyEntry._id : new mongoose.Types.ObjectId(String(historyEntry._id));
        if (trainingMaxes && typeof trainingMaxes === 'object') {
          await saveHistoryTmSnapshots(heId, trainingMaxes);
        }
        const tmSnap = await loadHistoryTmSnapshotsAsRecord(heId);
        res.status(201).json({ ...historyEntry.toObject(), trainingMaxes: tmSnap, rms: { bench: historyEntry.benchRm ?? 0, squat: historyEntry.squatRm ?? 0, deadlift: historyEntry.deadliftRm ?? 0 } });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// GET /api/training-maxes/history?routineId= — historial de progreso de una rutina
router.get(
  '/history',
  authenticateToken,
  [query('routineId').isMongoId().withMessage('routineId inválido')],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = new mongoose.Types.ObjectId((req as any).user.userId);
      await migrateLegacyHistoryEntries(userId);

      const routineId = String(req.query.routineId);
      const routine = await assertRoutineOwned(userId, routineId);
      if (!routine) {
        return res.status(404).json({ error: 'Rutina no encontrada' });
      }
      const rid = routine._id instanceof mongoose.Types.ObjectId ? routine._id : new mongoose.Types.ObjectId(String(routine._id));

      const history = await HistoryEntry.find({ userId, routineId: rid }).sort({
        dateISO: 1,
        year: 1,
        planWeek: 1,
        dayOfWeek: 1,
        createdAt: 1,
      }).lean();

      const heIds = history.map((h: any) =>
        h._id instanceof mongoose.Types.ObjectId ? h._id : new mongoose.Types.ObjectId(String(h._id))
      );
      const allSnapshots = heIds.length > 0
        ? await HistoryTmSnapshot.find({ historyEntryId: { $in: heIds } }).lean()
        : [];
      const snapByEntry = new Map<string, Record<string, number>>();
      for (const s of allSnapshots) {
        const k = String(s.historyEntryId);
        if (!snapByEntry.has(k)) snapByEntry.set(k, {});
        snapByEntry.get(k)![String(s.trainingMaxId)] = s.value;
      }

      const enriched = history.map((h: any) => ({
        ...h,
        trainingMaxes: snapByEntry.get(String(h._id)) || h.trainingMaxes || {},
        rms: {
          bench: h.benchRm ?? 0,
          squat: h.squatRm ?? 0,
          deadlift: h.deadliftRm ?? 0,
        },
        week: h.planWeek ?? h.week,
      }));
      res.json(enriched);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

export default router;
