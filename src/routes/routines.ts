import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth';
import { Routine } from '../models/Routine';
import { TrainingMax } from '../models/TrainingMax';
import { body, validationResult } from 'express-validator';
import { seedTrainingMaxesForRoutine } from '../utils/seedTrainingMaxes';

const router = express.Router();
const TOTAL_WEEKS = 52;

const getWeekType = (weekNumber: number): number => ((Math.max(1, weekNumber) - 1) % 4) + 1;

const normalizeTemplateWeek = (week: any, weekType: number) => {
  const safeDays = Array.isArray(week?.days) ? week.days : [];
  return {
    ...week,
    id: `template-w${weekType}`,
    number: weekType,
    days: safeDays.map((day: any, dayIdx: number) => ({
      ...day,
      id: `template-w${weekType}-d${dayIdx}`,
      exercises: Array.isArray(day?.exercises)
        ? day.exercises.map((exercise: any, exIdx: number) => ({
            ...exercise,
            id: `template-w${weekType}-d${dayIdx}-e${exIdx + 1}`,
          }))
        : [],
    })),
  };
};

const deriveBaseTemplateFromWeeks = (weeks: any[]): any[] => {
  const sourceWeeks = Array.isArray(weeks) ? weeks : [];
  const byType: Record<number, any> = {};
  sourceWeeks.forEach((week: any) => {
    const type = getWeekType(Number(week?.number) || 1);
    if (!byType[type]) byType[type] = week;
  });
  const fallback = sourceWeeks[0] || { id: 'template-empty', number: 1, days: [] };
  return [1, 2, 3, 4].map((type) => normalizeTemplateWeek(byType[type] || fallback, type));
};

const materializeWeeksFromTemplates = (baseTemplate: any[], overrides: any[], totalWeeks = TOTAL_WEEKS): any[] => {
  const byType = new Map<number, any>();
  (Array.isArray(baseTemplate) ? baseTemplate : []).forEach((week, idx) => {
    const type = Math.min(4, Math.max(1, Number(week?.number) || idx + 1));
    byType.set(type, normalizeTemplateWeek(week, type));
  });
  (Array.isArray(overrides) ? overrides : []).forEach((override) => {
    const type = Math.min(4, Math.max(1, Number(override?.weekType) || 1));
    if (override?.week) byType.set(type, normalizeTemplateWeek(override.week, type));
  });

  const fallback = byType.get(1) || normalizeTemplateWeek({ days: [] }, 1);
  return Array.from({ length: totalWeeks }, (_, i) => {
    const weekNumber = i + 1;
    const type = getWeekType(weekNumber);
    const template = byType.get(type) || fallback;
    return {
      ...template,
      id: `w${weekNumber}`,
      number: weekNumber,
      days: (template.days || []).map((day: any, dayIdx: number) => ({
        ...day,
        id: `w${weekNumber}-d${dayIdx}`,
        exercises: (day.exercises || []).map((exercise: any, exIdx: number) => ({
          ...exercise,
          id: `w${weekNumber}-d${dayIdx}-e${exIdx + 1}`,
        })),
      })),
    };
  });
};

// GET /api/routines - Obtener todas las rutinas del usuario
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const routines = await Routine.find({ userId }).sort({ createdAt: -1 });
    res.json(routines);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/routines/:id - Obtener una rutina específica
router.get('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const routine = await Routine.findOne({ _id: req.params.id, userId });
    if (!routine) {
      return res.status(404).json({ error: 'Rutina no encontrada' });
    }
    res.json(routine);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/routines - Crear una nueva rutina
router.post(
  '/',
  authenticateToken,
  [
    body('name').trim().notEmpty().withMessage('El nombre es requerido'),
    body('weeks').optional().isArray().withMessage('Las semanas deben ser un array'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = (req as any).user.userId;
      const { name, weeks, baseTemplate, weekTypeOverrides, versions } = req.body;
      const incomingWeeks = Array.isArray(weeks) ? weeks : [];
      const normalizedBaseTemplate = Array.isArray(baseTemplate) && baseTemplate.length > 0
        ? [1, 2, 3, 4].map((type) => {
            const found = baseTemplate.find((w: any) => (Number(w?.number) || 0) === type) || baseTemplate[type - 1] || baseTemplate[0];
            return normalizeTemplateWeek(found, type);
          })
        : deriveBaseTemplateFromWeeks(incomingWeeks);
      const normalizedOverrides = Array.isArray(weekTypeOverrides)
        ? weekTypeOverrides
            .filter((ov: any) => ov?.week)
            .map((ov: any) => ({
              weekType: Math.min(4, Math.max(1, Number(ov.weekType) || 1)),
              week: normalizeTemplateWeek(ov.week, Math.min(4, Math.max(1, Number(ov.weekType) || 1))),
            }))
        : [];
      const materializedWeeks = incomingWeeks.length > 0
        ? incomingWeeks
        : materializeWeeksFromTemplates(normalizedBaseTemplate, normalizedOverrides);
      const normalizedVersions = Array.isArray(versions) && versions.length > 0
        ? versions
        : [{ effectiveFromWeek: 1, weeks: materializedWeeks }];

      // Si es la primera rutina o se marca como activa, desactivar las demás
      const existingRoutines = await Routine.countDocuments({ userId });
      const isActive = existingRoutines === 0 || req.body.isActive === true;

      if (isActive) {
        await Routine.updateMany({ userId }, { isActive: false });
      }

      const routine = new Routine({
        userId,
        name,
        weeks: materializedWeeks,
        versions: normalizedVersions,
        baseTemplate: normalizedBaseTemplate,
        weekTypeOverrides: normalizedOverrides,
        logs: {},
        isActive,
        sameTemplateAllWeeks: req.body.sameTemplateAllWeeks !== false,
        hiddenFromSocial: !!req.body.hiddenFromSocial,
      });

      await routine.save();

      const uid = userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(String(userId));
      const rid = routine._id instanceof mongoose.Types.ObjectId ? routine._id : new mongoose.Types.ObjectId(String(routine._id));
      await seedTrainingMaxesForRoutine(uid, rid);

      res.status(201).json(routine);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// PUT /api/routines/:id - Actualizar una rutina
router.put(
  '/:id',
  authenticateToken,
  [
    body('name').optional().trim().notEmpty().withMessage('El nombre no puede estar vacío'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = (req as any).user.userId;
      const { name, weeks, baseTemplate, weekTypeOverrides, versions, logs, isActive, sameTemplateAllWeeks, hiddenFromSocial } = req.body;

      const routine = await Routine.findOne({ _id: req.params.id, userId });
      if (!routine) {
        return res.status(404).json({ error: 'Rutina no encontrada' });
      }

      if (name !== undefined) routine.name = name;
      if (sameTemplateAllWeeks !== undefined) (routine as any).sameTemplateAllWeeks = !!sameTemplateAllWeeks;
      if (hiddenFromSocial !== undefined) (routine as any).hiddenFromSocial = !!hiddenFromSocial;

      let nextWeeks = routine.weeks;
      let nextVersions = Array.isArray((routine as any).versions) && (routine as any).versions.length > 0
        ? (routine as any).versions
        : [{ effectiveFromWeek: 1, weeks: routine.weeks }];
      let nextBaseTemplate = Array.isArray(routine.baseTemplate) && routine.baseTemplate.length > 0
        ? routine.baseTemplate
        : deriveBaseTemplateFromWeeks(routine.weeks || []);
      let nextOverrides = Array.isArray(routine.weekTypeOverrides) ? routine.weekTypeOverrides : [];

      if (Array.isArray(baseTemplate) && baseTemplate.length > 0) {
        nextBaseTemplate = [1, 2, 3, 4].map((type) => {
          const found = baseTemplate.find((w: any) => (Number(w?.number) || 0) === type) || baseTemplate[type - 1] || baseTemplate[0];
          return normalizeTemplateWeek(found, type);
        });
      }

      if (Array.isArray(weekTypeOverrides)) {
        nextOverrides = weekTypeOverrides
          .filter((ov: any) => ov?.week)
          .map((ov: any) => {
            const type = Math.min(4, Math.max(1, Number(ov.weekType) || 1));
            return {
              weekType: type,
              week: normalizeTemplateWeek(ov.week, type),
            };
          });
      }

      if (Array.isArray(weeks) && weeks.length > 0) {
        nextWeeks = weeks;
        if (!(Array.isArray(versions) && versions.length > 0)) {
          nextVersions = [{ effectiveFromWeek: 1, weeks }];
        }
        if (!(Array.isArray(baseTemplate) && baseTemplate.length > 0)) {
          nextBaseTemplate = deriveBaseTemplateFromWeeks(weeks);
        }
      } else if (Array.isArray(baseTemplate) || Array.isArray(weekTypeOverrides)) {
        nextWeeks = materializeWeeksFromTemplates(nextBaseTemplate, nextOverrides);
        if (!(Array.isArray(versions) && versions.length > 0)) {
          nextVersions = [{ effectiveFromWeek: 1, weeks: nextWeeks }];
        }
      }

      if (Array.isArray(versions) && versions.length > 0) {
        nextVersions = versions;
      }

      routine.weeks = nextWeeks;
      (routine as any).versions = nextVersions;
      routine.baseTemplate = nextBaseTemplate;
      routine.weekTypeOverrides = nextOverrides;

      if (logs !== undefined) routine.logs = logs;
      
      // Si se marca como activa, desactivar las demás
      if (isActive === true) {
        await Routine.updateMany({ userId, _id: { $ne: req.params.id } }, { isActive: false });
        routine.isActive = true;
      } else if (isActive === false) {
        routine.isActive = false;
      }

      await routine.save();
      res.json(routine);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// DELETE /api/routines/:id - Eliminar una rutina
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const routine = await Routine.findOneAndDelete({ _id: req.params.id, userId });
    if (!routine) {
      return res.status(404).json({ error: 'Rutina no encontrada' });
    }
    await TrainingMax.deleteMany({ routineId: req.params.id, userId });
    res.json({ message: 'Rutina eliminada' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/routines/:id/activate - Activar una rutina
router.put('/:id/activate', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    
    // Desactivar todas las rutinas
    await Routine.updateMany({ userId }, { isActive: false });
    
    // Activar la rutina seleccionada
    const routine = await Routine.findOneAndUpdate(
      { _id: req.params.id, userId },
      { isActive: true },
      { new: true }
    );
    
    if (!routine) {
      return res.status(404).json({ error: 'Rutina no encontrada' });
    }
    
    res.json(routine);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
