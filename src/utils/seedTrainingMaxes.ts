import mongoose from 'mongoose';
import { TrainingMax } from '../models/TrainingMax';

export const DEFAULT_TRAINING_MAXES: Array<{
  name: string;
  value: number;
  mode: 'weight' | 'reps' | 'seconds';
  linkedExercise?: 'bench' | 'squat' | 'deadlift';
}> = [
  { name: 'Press Banca', value: 110, mode: 'weight', linkedExercise: 'bench' },
  { name: 'Sentadilla', value: 140, mode: 'weight', linkedExercise: 'squat' },
  { name: 'Peso Muerto', value: 190, mode: 'weight', linkedExercise: 'deadlift' },
  { name: 'Dominadas', value: 15, mode: 'reps' },
  { name: 'Plancha', value: 60, mode: 'seconds' },
];

/** Inserta TM por defecto solo si la rutina aún no tiene ninguno. */
export async function seedTrainingMaxesForRoutine(
  userId: mongoose.Types.ObjectId,
  routineId: mongoose.Types.ObjectId
) {
  const existing = await TrainingMax.countDocuments({ routineId });
  if (existing > 0) return;
  for (const d of DEFAULT_TRAINING_MAXES) {
    await TrainingMax.create({
      userId,
      routineId,
      name: d.name,
      value: d.value,
      mode: d.mode,
      linkedExercise: d.linkedExercise,
    });
  }
}
