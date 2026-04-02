/**
 * Puntuación de torneos:
 * - Peso (kg): puntos IPF GL (Goodlift) según ejercicio y género (bodyWeightScoring no aplica).
 * - Repeticiones / segundos: según bodyWeightScoring (más peso → más puntos, menos peso → más puntos, o sin ponderar).
 * Modo "solo marca": el ranking usa el valor bruto (kg, reps o s).
 */

export type ChallengeScoreType = 'max_reps' | 'weight' | 'seconds';
export type Gender = 'hombre' | 'mujer';

export type BodyWeightScoringMode = 'heavier_more' | 'lighter_more' | 'neutral';

export function normalizeBodyWeightScoring(raw: unknown): BodyWeightScoringMode {
  if (raw === 'lighter_more' || raw === 'neutral') return raw;
  return 'heavier_more';
}

type IpfGlCoefficients = { a: number; b: number; c: number };

const IPF_GL_COEFFICIENTS: Record<Gender, Record<'powerlifting' | 'squat' | 'bench' | 'deadlift', IpfGlCoefficients>> = {
  hombre: {
    powerlifting: { a: 1199.72839, b: 1025.18162, c: 0.00921 },
    squat: { a: 1236.25115, b: 1449.21864, c: 0.01644 },
    bench: { a: 381.22073, b: 733.79378, c: 0.02398 },
    deadlift: { a: 674.585, b: 1149.692, c: 0.015 },
  },
  mujer: {
    powerlifting: { a: 610.32796, b: 1045.59282, c: 0.03048 },
    squat: { a: 758.63878, b: 949.31382, c: 0.02435 },
    bench: { a: 221.82209, b: 357.00377, c: 0.02937 },
    deadlift: { a: 482.50024, b: 819.10084, c: 0.02963 },
  },
};

function getIpfGlCoefficients(exercise: string, gender: Gender): IpfGlCoefficients {
  const normalized = exercise.toLowerCase();
  if (/(bench|press banca|banca)/i.test(normalized)) return IPF_GL_COEFFICIENTS[gender].bench;
  if (/(squat|sentadilla)/i.test(normalized)) return IPF_GL_COEFFICIENTS[gender].squat;
  if (/(deadlift|peso muerto)/i.test(normalized)) return IPF_GL_COEFFICIENTS[gender].deadlift;
  return IPF_GL_COEFFICIENTS[gender].powerlifting;
}

function computeIpfGlPoints(value: number, bodyWeight: number, exercise: string, gender: Gender): number {
  const safeBodyWeight = bodyWeight > 0 ? bodyWeight : 70;
  const coeffs = getIpfGlCoefficients(exercise, gender);
  const denominator = coeffs.a - coeffs.b * Math.exp(-coeffs.c * safeBodyWeight);
  if (denominator <= 0) return 0;
  const points = (100 / denominator) * value;
  return Math.round(points * 100) / 100;
}

/** Dominadas, chin-ups, muscle-up: el trabajo por rep sube con el peso corporal. */
export function isPullUpLikeExercise(exercise: string): boolean {
  return /(dominad|pull[\s-]?up|chin|muscle|tracci[oó]n|barra fija)/i.test(exercise);
}

/** Solo reps y segundos: +25 % al score para género mujer (no aplica a torneos por peso IPF GL). */
function genderFactor(gender?: Gender): number {
  return gender === 'mujer' ? 1.25 : 1;
}

const REF_BW = 70;

function repsBodyWeightFactor(
  mode: BodyWeightScoringMode,
  rel: number,
  exercise: string
): number {
  const pull = isPullUpLikeExercise(exercise);
  switch (mode) {
    case 'neutral':
      return 1;
    case 'lighter_more':
      if (pull) return 1 / rel;
      return Math.pow(rel, -0.35);
    case 'heavier_more':
    default:
      if (pull) return rel;
      return Math.pow(rel, 0.35);
  }
}

function secondsBodyWeightFactor(mode: BodyWeightScoringMode, rel: number): number {
  switch (mode) {
    case 'neutral':
      return 1;
    case 'lighter_more':
      return Math.pow(rel, -0.5);
    case 'heavier_more':
    default:
      return Math.pow(rel, 0.5);
  }
}

/**
 * Puntos mostrados y guardados cuando el torneo usa sistema de puntos.
 */
export function computeChallengeScore(
  type: ChallengeScoreType,
  value: number,
  bodyWeight: number,
  gender: Gender | undefined,
  exercise: string,
  usePointsSystem: boolean,
  bodyWeightScoring: BodyWeightScoringMode = 'heavier_more'
): number {
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;

  if (!usePointsSystem) {
    return Math.round(v * 1000) / 1000;
  }

  let bw = bodyWeight > 0 ? bodyWeight : 70;
  const g: Gender = gender === 'mujer' ? 'mujer' : 'hombre';
  const gf = genderFactor(g);
  const mode = normalizeBodyWeightScoring(bodyWeightScoring);
  const rel = bw / REF_BW;

  switch (type) {
    case 'weight':
      return computeIpfGlPoints(v, bw, exercise, g);
    case 'max_reps': {
      const bwF = repsBodyWeightFactor(mode, rel, exercise);
      const score = v * bwF * gf;
      return Math.round(score * 100) / 100;
    }
    case 'seconds': {
      const bwF = secondsBodyWeightFactor(mode, rel);
      const score = v * bwF * gf;
      return Math.round(score * 100) / 100;
    }
    default:
      return Math.round(v * 100) / 100;
  }
}

/** Misma lógica que el ranking en la API (puntos o marca bruta según usePointsSystem). */
export function computeDisplayScoreForChallengeParticipant(
  challenge: {
    type: ChallengeScoreType | string;
    exercise: string;
    usePointsSystem?: boolean;
    bodyWeightScoring?: unknown;
  },
  value: number,
  bodyWeight: number,
  gender: Gender | undefined
): number {
  const usePts = challenge.usePointsSystem !== false;
  const bwMode = normalizeBodyWeightScoring(challenge.bodyWeightScoring);
  return computeChallengeScore(
    challenge.type as ChallengeScoreType,
    value,
    bodyWeight,
    gender,
    challenge.exercise,
    usePts,
    bwMode
  );
}
