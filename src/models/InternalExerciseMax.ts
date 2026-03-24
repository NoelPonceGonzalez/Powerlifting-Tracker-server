import mongoose, { Schema, Document } from 'mongoose';

/** TM derivado del rendimiento en ejercicios sin vínculo oficial (mismo nombre exacto / normalizado). */
export interface IInternalExerciseMax extends Document {
  userId: mongoose.Types.ObjectId;
  /** Nombre tal como en la rutina (primera vez que se registró). */
  name: string;
  nameNormalized: string;
  /** E1RM (kg) redondeado a 2,5 — ejercicios modo peso. */
  valueWeight?: number;
  /** Mejor marca en repeticiones — modo reps. */
  valueReps?: number;
  /** Mejor tiempo (segundos) — modo segundos. */
  valueSeconds?: number;
  /** @deprecated Usar valueWeight; se migra automáticamente desde documentos antiguos. */
  value?: number;
  createdAt: Date;
  updatedAt: Date;
}

const InternalExerciseMaxSchema = new Schema<IInternalExerciseMax>(
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
    nameNormalized: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    valueWeight: { type: Number },
    valueReps: { type: Number },
    valueSeconds: { type: Number },
    /** Legado: un solo valor; se copia a valueWeight al leer/actualizar. */
    value: { type: Number },
  },
  {
    timestamps: true,
  }
);

InternalExerciseMaxSchema.index({ userId: 1, nameNormalized: 1 }, { unique: true });

export const InternalExerciseMax = mongoose.model<IInternalExerciseMax>(
  'InternalExerciseMax',
  InternalExerciseMaxSchema
);
