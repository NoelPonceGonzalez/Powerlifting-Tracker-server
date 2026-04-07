import mongoose, { Schema, Document } from 'mongoose';

export interface ITemplateWeek extends Document {
  programVersionId: mongoose.Types.ObjectId;
  /** Posición 1–N dentro del ciclo (N = cycleLength, hasta 52). */
  slot: number;
}

const TemplateWeekSchema = new Schema<ITemplateWeek>(
  {
    programVersionId: { type: Schema.Types.ObjectId, ref: 'ProgramVersion', required: true, index: true },
    slot: { type: Number, required: true, min: 1, max: 52 },
  },
  { timestamps: false }
);

TemplateWeekSchema.index({ programVersionId: 1, slot: 1 }, { unique: true });

export const TemplateWeek = mongoose.model<ITemplateWeek>('TemplateWeek', TemplateWeekSchema);
