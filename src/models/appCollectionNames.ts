/**
 * Lista única de colecciones MongoDB que usa esta aplicación (nombres reales en runtime).
 * Si añades un modelo nuevo, impórtalo aquí para que no se borre como "no usada".
 */
import { Challenge } from './Challenge';
import { ExerciseLog } from './ExerciseLog';
import { Friendship } from './Friendship';
import { GymCheckIn } from './GymCheckIn';
import { HistoryEntry } from './HistoryEntry';
import { HistoryTmSnapshot } from './HistoryTmSnapshot';
import { InternalExerciseMax } from './InternalExerciseMax';
import { Notification } from './Notification';
import { PendingSignup } from './PendingSignup';
import { ProgramVersion } from './ProgramVersion';
import { Routine } from './Routine';
import { TemplateDay } from './TemplateDay';
import { TemplateExercise } from './TemplateExercise';
import { TemplateWeek } from './TemplateWeek';
import { TrainingMax } from './TrainingMax';
import { User } from './User';
import { WorkoutExercise } from './WorkoutExercise';
import { WorkoutSession } from './WorkoutSession';
import { WorkoutSet } from './WorkoutSet';

const REGISTERED_MODELS = [
  User,
  PendingSignup,
  Routine,
  TrainingMax,
  HistoryEntry,
  HistoryTmSnapshot,
  ProgramVersion,
  TemplateWeek,
  TemplateDay,
  TemplateExercise,
  WorkoutSession,
  WorkoutExercise,
  WorkoutSet,
  ExerciseLog,
  Notification,
  InternalExerciseMax,
  GymCheckIn,
  Friendship,
  Challenge,
] as const;

export function getAppMongoCollectionNames(): Set<string> {
  const names = new Set<string>();
  for (const M of REGISTERED_MODELS) {
    const n = M.collection?.collectionName;
    if (n) names.add(n);
  }
  return names;
}
