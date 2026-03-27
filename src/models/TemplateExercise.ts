import mongoose, { Schema, Document } from 'mongoose';

export interface ITemplateExercise extends Document {
  templateDayId: mongoose.Types.ObjectId;
  sortOrder: number;
  exerciseName: string;
  sets: number;
  repsInt?: number;
  repsText?: string;
  pct?: number;
  pctPerSet?: number[];
  weight?: number;
  mode: 'weight' | 'reps' | 'seconds';
  linkedTrainingMaxId?: mongoose.Types.ObjectId;
  /** IDs de cliente (p. ej. tm-1) cuando aún no hay ObjectId de TM */
  linkedClientKey?: string;
}

const TemplateExerciseSchema = new Schema<ITemplateExercise>(
  {
    templateDayId: { type: Schema.Types.ObjectId, ref: 'TemplateDay', required: true, index: true },
    sortOrder: { type: Number, required: true, default: 0 },
    exerciseName: { type: String, required: true },
    sets: { type: Number, required: true, default: 1 },
    repsInt: { type: Number },
    repsText: { type: String },
    pct: { type: Number },
    pctPerSet: [{ type: Number }],
    weight: { type: Number },
    mode: { type: String, enum: ['weight', 'reps', 'seconds'], default: 'weight' },
    linkedTrainingMaxId: { type: Schema.Types.ObjectId, ref: 'TrainingMax' },
    linkedClientKey: { type: String, trim: true, maxlength: 128 },
  },
  { timestamps: false }
);

TemplateExerciseSchema.index({ templateDayId: 1, sortOrder: 1 }, { unique: true });

export const TemplateExercise = mongoose.model<ITemplateExercise>('TemplateExercise', TemplateExerciseSchema);
