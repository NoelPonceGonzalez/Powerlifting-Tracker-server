import mongoose, { Schema, Document } from 'mongoose';

export interface IProgramVersion extends Document {
  routineId: mongoose.Types.ObjectId;
  effectiveFromWeek: number;
  /** Ciclo con el que se guardó esta versión: si la rutina cambia de ciclo, las semanas pasadas se siguen leyendo bien. */
  cycleLength: number;
  sortOrder: number;
  createdAt: Date;
}

const ProgramVersionSchema = new Schema<IProgramVersion>(
  {
    routineId: { type: Schema.Types.ObjectId, ref: 'Routine', required: true, index: true },
    effectiveFromWeek: { type: Number, required: true, min: 1, max: 52 },
    cycleLength: { type: Number, default: 4, min: 1, max: 52 },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ProgramVersionSchema.index({ routineId: 1, effectiveFromWeek: 1 });

export const ProgramVersion = mongoose.model<IProgramVersion>('ProgramVersion', ProgramVersionSchema);
