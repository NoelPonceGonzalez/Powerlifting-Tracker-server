import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth';
import { TrainingMax } from '../models/TrainingMax';
import { Routine } from '../models/Routine';
import { HistoryEntry } from '../models/HistoryEntry';
import { body, query, validationResult } from 'express-validator';
import { seedTrainingMaxesForRoutine } from '../utils/seedTrainingMaxes';

const router = express.Router();

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
      let trainingMaxes = await TrainingMax.find({ userId, routineId: rid }).sort({ createdAt: 1 });
      if (trainingMaxes.length === 0) {
        await seedTrainingMaxesForRoutine(userId, rid);
        trainingMaxes = await TrainingMax.find({ userId, routineId: rid }).sort({ createdAt: 1 });
      }
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
      res.status(201).json(trainingMax);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// PUT /api/training-maxes/:id - Actualizar un Training Max
router.put(
  '/:id',
  authenticateToken,
  [
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
      const { name, value, mode, linkedExercise, sharedToSocial } = req.body;

      const trainingMax = await TrainingMax.findOne({ _id: req.params.id, userId });
      if (!trainingMax) {
        return res.status(404).json({ error: 'Training Max no encontrado' });
      }

      if (name !== undefined) trainingMax.name = name;
      if (value !== undefined) trainingMax.value = value;
      if (mode !== undefined) trainingMax.mode = mode;
      if (linkedExercise !== undefined) trainingMax.linkedExercise = linkedExercise;
      if (sharedToSocial !== undefined) (trainingMax as any).sharedToSocial = !!sharedToSocial;

      await trainingMax.save();
      res.json(trainingMax);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// DELETE /api/training-maxes/:id - Eliminar un Training Max
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = new mongoose.Types.ObjectId((req as any).user.userId);
    const trainingMax = await TrainingMax.findOneAndDelete({ _id: req.params.id, userId });
    if (!trainingMax) {
      return res.status(404).json({ error: 'Training Max no encontrado' });
    }
    res.json({ message: 'Training Max eliminado' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

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
      const { date, week, year, rms, total, trainingMaxes, routineId } = req.body;

      const routine = await assertRoutineOwned(userId, routineId);
      if (!routine) {
        return res.status(404).json({ error: 'Rutina no encontrada' });
      }
      const rid = routine._id instanceof mongoose.Types.ObjectId ? routine._id : new mongoose.Types.ObjectId(String(routine._id));

      const query: any = { userId, routineId: rid };
      if (week != null && year != null) {
        query.year = Number(year);
        query.week = Number(week);
      } else {
        query.date = date;
      }
      const existing = await HistoryEntry.findOne(query);

      if (existing) {
        existing.rms = rms;
        existing.total = total;
        existing.trainingMaxes = trainingMaxes;
        if (week !== undefined) existing.week = Number(week);
        if (year !== undefined) existing.year = Number(year);
        existing.routineId = rid;
        await existing.save();
        res.json(existing);
      } else {
        const historyEntry = new HistoryEntry({
          userId,
          routineId: rid,
          date,
          week: week != null ? Number(week) : undefined,
          year: year != null ? Number(year) : undefined,
          rms,
          total,
          trainingMaxes,
        });
        await historyEntry.save();
        res.status(201).json(historyEntry);
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

      const history = await HistoryEntry.find({ userId, routineId: rid }).sort({ year: 1, week: 1, createdAt: 1 });
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

export default router;
