/**
 * Puntuación de torneos, justa entre pesos y géneros.
 *
 * Fuerza (kg): IPF GL oficial (mayo 2020, vigente 2025).
 *   GL = resultado × 100 / (A − B·e^(−C·peso))
 *   Banca clásica → coeficientes Classic Bench Press.
 *   Sentadilla, peso muerto y el resto → Classic Powerlifting
 *   (la IPF no publica GL de sentadilla/muerto sueltos; usar equipped
 *   o coeficientes inventados sesga a hombres o a gente con equipación).
 *
 * Reps / tiempo: peso corporal (alometría) + ratio de rendimiento
 *   publicado por género (NSCA / Nuzzo 2023). No un +25 % plano:
 *   el tronco (plancha) está casi a la par; el tren superior no.
 */

export type ChallengeScoreType = 'max_reps' | 'weight' | 'seconds';
export type Gender = 'hombre' | 'mujer';

export type BodyWeightScoringMode = 'heavier_more' | 'lighter_more' | 'neutral';

export function normalizeBodyWeightScoring(raw: unknown): BodyWeightScoringMode {
  if (raw === 'lighter_more' || raw === 'neutral') return raw;
  return 'heavier_more';
}

type IpfGlCoefficients = { a: number; b: number; c: number };

/** Coeficientes oficiales IPF GL 2020 (classic / raw). */
const IPF_GL_CLASSIC: Record<Gender, { total: IpfGlCoefficients; bench: IpfGlCoefficients }> = {
  hombre: {
    total: { a: 1199.72839, b: 1025.18162, c: 0.00921 },
    bench: { a: 320.98041, b: 281.40258, c: 0.01008 },
  },
  mujer: {
    total: { a: 610.32796, b: 1045.59282, c: 0.03048 },
    bench: { a: 142.40398, b: 442.52671, c: 0.04724 },
  },
};

function getIpfGlCoefficients(exercise: string, gender: Gender): IpfGlCoefficients {
  const normalized = exercise.toLowerCase();
  if (/(bench|press banca|banca|press de banca)/i.test(normalized)) {
    return IPF_GL_CLASSIC[gender].bench;
  }
  return IPF_GL_CLASSIC[gender].total;
}

function computeIpfGlPoints(value: number, bodyWeight: number, exercise: string, gender: Gender): number {
  const bw = bodyWeight > 0 ? bodyWeight : gender === 'mujer' ? 60 : 80;
  const coeffs = getIpfGlCoefficients(exercise, gender);
  const denominator = coeffs.a - coeffs.b * Math.exp(-coeffs.c * bw);
  if (denominator <= 0) return 0;
  const coefficient = Math.round((100 / denominator) * 1e6) / 1e6;
  const points = coefficient * value;
  return Math.round(points * 100) / 100;
}

/** Dominadas, chin-ups, muscle-up: el trabajo por rep sube con el peso corporal. */
export function isPullUpLikeExercise(exercise: string): boolean {
  return /(dominad|pull[\s-]?up|chin|muscle|tracci[oó]n|barra fija)/i.test(exercise);
}

function isLowerBodyExercise(exercise: string): boolean {
  return /(sentadilla|squat|zancada|lunge|hip thrust|peso muerto|deadlift|prensa|gemelo|femoral)/i.test(exercise);
}

/**
 * Multiplicador para igualar rendimiento medio mujer/hombre.
 * Ratios F/M típicos (fuerza relativa / endurance): tren superior ~0.62,
 * tren inferior ~0.72, isométrico de tronco ~0.93.
 */
function genderFactor(type: ChallengeScoreType, exercise: string, gender?: Gender): number {
  if (gender !== 'mujer') return 1;
  if (type === 'seconds') return 1.08;
  if (isPullUpLikeExercise(exercise)) return 1.55;
  if (isLowerBodyExercise(exercise)) return 1.32;
  return 1.4;
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

  const bw = bodyWeight > 0 ? bodyWeight : 70;
  const g: Gender = gender === 'mujer' ? 'mujer' : 'hombre';
  const gf = genderFactor(type, exercise, g);
  const mode = normalizeBodyWeightScoring(bodyWeightScoring);
  const rel = bw / REF_BW;

  switch (type) {
    case 'weight':
      return computeIpfGlPoints(v, bw, exercise, g);
    case 'max_reps': {
      const score = v * repsBodyWeightFactor(mode, rel, exercise) * gf;
      return Math.round(score * 100) / 100;
    }
    case 'seconds': {
      const score = v * secondsBodyWeightFactor(mode, rel) * gf;
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
