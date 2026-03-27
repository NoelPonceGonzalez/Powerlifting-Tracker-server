import mongoose, { Schema, Document } from 'mongoose';

export interface ITemplateDay extends Document {
  templateWeekId: mongoose.Types.ObjectId;
  dayIndex: number;
  name: string;
  dayType: 'workout' | 'rest' | 'deload';
}

const TemplateDaySchema = new Schema<ITemplateDay>(
  {
    templateWeekId: { type: Schema.Types.ObjectId, ref: 'TemplateWeek', required: true, index: true },
    dayIndex: { type: Number, required: true, min: 0 },
    name: { type: String, default: '' },
    dayType: { type: String, enum: ['workout', 'rest', 'deload'], default: 'workout' },
  },
  { timestamps: false }
);

TemplateDaySchema.index({ templateWeekId: 1, dayIndex: 1 }, { unique: true });

export const TemplateDay = mongoose.model<ITemplateDay>('TemplateDay', TemplateDaySchema);
