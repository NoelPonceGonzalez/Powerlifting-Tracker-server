import mongoose, { Schema, Document } from 'mongoose';

/**
 * Routine: solo metadatos de la rutina.
 * Plan → ProgramVersion + TemplateWeek/Day/Exercise
 * Logs → WorkoutSession/Exercise/Set
 */
export interface IRoutine extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  isActive: boolean;
  sameTemplateAllWeeks?: boolean;
  hiddenFromSocial?: boolean;
  cycleLength?: number;
  /** Lineal: semanas civiles 1–53. Por bloque (sameTemplateAllWeeks false): posición en el mesociclo 1…cycleLength. */
  skippedWeeks?: number[];
  /** ISO: desde aquí los % de progreso en gráficos usan este punto como referencia (no modifica TM). */
  progressCheckpointAt?: Date;
  /** Snapshot de TM al momento del checkpoint ({ tmId: valor }). El baseline de % se toma de aquí. */
  progressCheckpointTms?: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

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
    cycleLength: {
      type: Number,
      default: 4,
      min: 1,
      max: 52,
    },
    skippedWeeks: {
      type: [Number],
      default: [],
    },
    progressCheckpointAt: {
      type: Date,
      default: undefined,
    },
    progressCheckpointTms: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
  },
  {
    timestamps: true,
    strict: false, // allow legacy fields (weeks, logs, versions…) until fully migrated
  }
);

RoutineSchema.index({ userId: 1, isActive: 1 });
RoutineSchema.index({ userId: 1, name: 1 });

export const Routine = mongoose.model<IRoutine>('Routine', RoutineSchema);
