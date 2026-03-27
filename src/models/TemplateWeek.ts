import mongoose, { Schema, Document } from 'mongoose';

export interface ITemplateWeek extends Document {
  programVersionId: mongoose.Types.ObjectId;
  slot: number; // 1-4 position in mesocycle
}

const TemplateWeekSchema = new Schema<ITemplateWeek>(
  {
    programVersionId: { type: Schema.Types.ObjectId, ref: 'ProgramVersion', required: true, index: true },
    slot: { type: Number, required: true, min: 1, max: 4 },
  },
  { timestamps: false }
);

TemplateWeekSchema.index({ programVersionId: 1, slot: 1 }, { unique: true });

export const TemplateWeek = mongoose.model<ITemplateWeek>('TemplateWeek', TemplateWeekSchema);
