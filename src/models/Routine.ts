import mongoose, { Schema, Document } from 'mongoose';

export interface IPlannedExercise {
  id: string;
  name: string;
  sets: number;
  reps: string | number;
  pct?: number;
  pctPerSet?: number[];
  weight?: number;
  mode: 'weight' | 'reps' | 'seconds';
  linkedTo?: string; // ID of a TrainingMax
}

export interface ITrainingDay {
  id: string;
  name: string;
  type: 'workout' | 'rest' | 'deload';
  exercises: IPlannedExercise[];
}

export interface ITrainingWeek {
  id: string;
  number: number;
  days: ITrainingDay[];
}

export interface IWeekTypeOverride {
  weekType: number; // 1..4
  week: ITrainingWeek;
}

export interface IRoutineVersion {
  effectiveFromWeek: number;
  weeks: ITrainingWeek[];
}

export interface ILogEntry {
  rpe: string;
  notes: string;
  completed: boolean;
  weight?: number;
  sets?: Array<{
    id: string;
    reps: number | null;
    weight: number | null;
    completed: boolean;
    /** 'kg' | absoluto; 'pct' | % sobre referencia/TM al guardar la serie. */
    inputMode?: 'kg' | 'pct';
  }>;
}

export interface IRoutine extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  isActive: boolean;
  sameTemplateAllWeeks?: boolean; // true = mismo contenido todas las semanas; false = ciclo 1-4
  hiddenFromSocial?: boolean; // true = no mostrar/copiar en perfil social
  weeks: ITrainingWeek[];
  versions: IRoutineVersion[];
  baseTemplate: ITrainingWeek[]; // Semana 1..4 base
  weekTypeOverrides: IWeekTypeOverride[]; // Overrides por tipo de semana
  logs: Record<string, ILogEntry>; // logId -> LogEntry
  createdAt: Date;
  updatedAt: Date;
}

const PlannedExerciseSchema = new Schema<IPlannedExercise>({
  id: { type: String, required: true },
  name: { type: String, required: true },
  sets: { type: Number, required: true },
  reps: { type: Schema.Types.Mixed, required: true },
  pct: { type: Number },
  pctPerSet: [{ type: Number }],
  weight: { type: Number },
  mode: { type: String, enum: ['weight', 'reps', 'seconds'], required: true },
  linkedTo: { type: String },
}, { _id: false });

const TrainingDaySchema = new Schema<ITrainingDay>({
  id: { type: String, required: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['workout', 'rest', 'deload'], required: true },
  exercises: [PlannedExerciseSchema],
}, { _id: false });

const TrainingWeekSchema = new Schema<ITrainingWeek>({
  id: { type: String, required: true },
  number: { type: Number, required: true },
  days: [TrainingDaySchema],
}, { _id: false });

const WeekTypeOverrideSchema = new Schema<IWeekTypeOverride>({
  weekType: { type: Number, required: true, min: 1, max: 4 },
  week: { type: TrainingWeekSchema, required: true },
}, { _id: false });

const RoutineVersionSchema = new Schema<IRoutineVersion>({
  effectiveFromWeek: { type: Number, required: true },
  weeks: [TrainingWeekSchema],
}, { _id: false });

const LogEntrySchema = new Schema<ILogEntry>({
  rpe: { type: String, default: '' },
  notes: { type: String, default: '' },
  completed: { type: Boolean, default: false },
  weight: { type: Number },
  sets: [{
    id: String,
    reps: Schema.Types.Mixed,
    weight: Schema.Types.Mixed,
    completed: Boolean,
    inputMode: { type: String, enum: ['kg', 'pct'] },
  }],
}, { _id: false });

const RoutineSchema = new Schema<IRoutine>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: false,
      index: true,
    },
    sameTemplateAllWeeks: {
      type: Boolean,
      default: true,
    },
    hiddenFromSocial: {
      type: Boolean,
      default: false,
    },
    weeks: [TrainingWeekSchema],
    versions: {
      type: [RoutineVersionSchema],
      default: [],
    },
    baseTemplate: {
      type: [TrainingWeekSchema],
      default: [],
    },
    weekTypeOverrides: {
      type: [WeekTypeOverrideSchema],
      default: [],
    },
    logs: {
      type: Map,
      of: LogEntrySchema,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

RoutineSchema.index({ userId: 1, isActive: 1 });
RoutineSchema.index({ userId: 1, name: 1 });

export const Routine = mongoose.model<IRoutine>('Routine', RoutineSchema);
