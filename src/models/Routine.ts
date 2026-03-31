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
  skippedWeeks?: number[];
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
  },
  {
    timestamps: true,
    strict: false, // allow legacy fields (weeks, logs, versions…) until fully migrated
  }
);

RoutineSchema.index({ userId: 1, isActive: 1 });
RoutineSchema.index({ userId: 1, name: 1 });

export const Routine = mongoose.model<IRoutine>('Routine', RoutineSchema);
