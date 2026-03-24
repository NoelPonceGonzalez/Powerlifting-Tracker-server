import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth';
import { InternalExerciseMax } from '../models/InternalExerciseMax';
import { Routine } from '../models/Routine';
import { body, query, validationResult } from 'express-validator';

const router = express.Router();

function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ');
}

type InternalMode = 'weight' | 'reps' | 'seconds';

/** Copia `value` legado a valueWeight si hace falta. */
function migrateLegacyFields(doc: any): void {
  const legacy = doc.value;
  if (legacy != null && doc.valueWeight == null) {
    doc.valueWeight = legacy;
  }
}

async function assertRoutineOwned(userId: mongoose.Types.ObjectId, routineId: string) {
  return Routine.findOne({ _id: routineId, userId });
}

/** Asigna documentos legados sin rutina a la rutina activa (misma idea que training-maxes). */
async function migrateLegacyInternalExerciseMaxes(userId: mongoose.Types.ObjectId) {
  const orphanCount = await InternalExerciseMax.countDocuments({
    userId,
    $or: [{ routineId: { $exists: false } }, { routineId: null }],
  });
  if (orphanCount === 0) return;
  const activeRoutine = await Routine.findOne({ userId, isActive: true });
  if (!activeRoutine) return;
  await InternalExerciseMax.updateMany(
    { userId, $or: [{ routineId: { $exists: false } }, { routineId: null }] },
    { $set: { routineId: activeRoutine._id } }
  );
}

/** Lista de TM internos de una rutina (mismo nombre en otra rutina = otros valores). */
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
      await migrateLegacyInternalExerciseMaxes(userId);

      const routineId = String(req.query.routineId);
      const routine = await assertRoutineOwned(userId, routineId);
      if (!routine) {
        return res.status(404).json({ error: 'Rutina no encontrada' });
      }
      const rid =
        routine._id instanceof mongoose.Types.ObjectId
          ? routine._id
          : new mongoose.Types.ObjectId(String(routine._id));

      const rows = await InternalExerciseMax.find({ userId, routineId: rid }).sort({ name: 1 });
      for (const doc of rows) {
        const any = doc as any;
        if (any.value != null && any.valueWeight == null) {
          any.valueWeight = any.value;
          await doc.save();
        }
      }
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * Sube o crea: actualiza solo el campo del modo indicado con max(previo, candidateValue).
 * Por rutina: `routineId` obligatorio.
 */
router.post(
  '/upsert',
  authenticateToken,
  [
    body('routineId').isMongoId().withMessage('routineId inválido'),
    body('name').trim().notEmpty().withMessage('name requerido'),
    body('mode').isIn(['weight', 'reps', 'seconds']).withMessage('mode inválido'),
    body('candidateValue').isNumeric().withMessage('candidateValue numérico'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = new mongoose.Types.ObjectId((req as any).user.userId);
      const routineId = String(req.body.routineId);
      const name = String(req.body.name).trim();
      const mode = String(req.body.mode) as InternalMode;
      const candidateValue = Number(req.body.candidateValue);
      const nameNormalized = normalizeName(name);

      const routine = await assertRoutineOwned(userId, routineId);
      if (!routine) {
        return res.status(404).json({ error: 'Rutina no encontrada' });
      }
      const rid =
        routine._id instanceof mongoose.Types.ObjectId
          ? routine._id
          : new mongoose.Types.ObjectId(String(routine._id));

      const existing = await InternalExerciseMax.findOne({ userId, routineId: rid, nameNormalized });
      if (existing) {
        migrateLegacyFields(existing);
        const field =
          mode === 'weight' ? 'valueWeight' : mode === 'reps' ? 'valueReps' : 'valueSeconds';
        const ex = existing as any;
        const prev =
          field === 'valueWeight'
            ? ex.valueWeight ?? ex.value ?? 0
            : ex[field] ?? 0;
        if (candidateValue > prev) {
          ex[field] = candidateValue;
        }
        await existing.save();
        return res.json(existing);
      }

      const payload: Record<string, unknown> = {
        userId,
        routineId: rid,
        name,
        nameNormalized,
      };
      if (mode === 'weight') payload.valueWeight = candidateValue;
      else if (mode === 'reps') payload.valueReps = candidateValue;
      else payload.valueSeconds = candidateValue;

      const created = await InternalExerciseMax.create(payload);
      res.status(201).json(created);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/** Actualizar manualmente uno o varios campos (documento debe ser de `routineId`). */
router.put(
  '/:id',
  authenticateToken,
  [body('routineId').isMongoId().withMessage('routineId inválido')],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = new mongoose.Types.ObjectId((req as any).user.userId);
      const routineId = String(req.body.routineId);
      const routine = await assertRoutineOwned(userId, routineId);
      if (!routine) {
        return res.status(404).json({ error: 'Rutina no encontrada' });
      }
      const rid =
        routine._id instanceof mongoose.Types.ObjectId
          ? routine._id
          : new mongoose.Types.ObjectId(String(routine._id));

      const { valueWeight, valueReps, valueSeconds, value } = req.body;
      const doc = await InternalExerciseMax.findOne({ _id: req.params.id, userId, routineId: rid });
      if (!doc) {
        return res.status(404).json({ error: 'No encontrado en esta rutina' });
      }
      migrateLegacyFields(doc);
      if (valueWeight !== undefined) (doc as any).valueWeight = Number(valueWeight);
      if (valueReps !== undefined) (doc as any).valueReps = Number(valueReps);
      if (valueSeconds !== undefined) (doc as any).valueSeconds = Number(valueSeconds);
      if (value !== undefined) (doc as any).value = Number(value);
      await doc.save();
      res.json(doc);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

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

      const doc = await InternalExerciseMax.findOneAndDelete({ _id: req.params.id, userId, routineId: rid });
      if (!doc) {
        return res.status(404).json({ error: 'No encontrado en esta rutina' });
      }
      res.json({ message: 'Eliminado' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

export default router;
