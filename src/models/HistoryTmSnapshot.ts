import mongoose, { Schema, Document } from 'mongoose';

export interface IHistoryTmSnapshot extends Document {
  historyEntryId: mongoose.Types.ObjectId;
  trainingMaxId: mongoose.Types.ObjectId;
  value: number;
}

const HistoryTmSnapshotSchema = new Schema<IHistoryTmSnapshot>(
  {
    historyEntryId: { type: Schema.Types.ObjectId, ref: 'HistoryEntry', required: true, index: true },
    trainingMaxId: { type: Schema.Types.ObjectId, ref: 'TrainingMax', required: true },
    value: { type: Number, required: true },
  },
  { timestamps: false }
);

HistoryTmSnapshotSchema.index({ historyEntryId: 1, trainingMaxId: 1 }, { unique: true });

export const HistoryTmSnapshot = mongoose.model<IHistoryTmSnapshot>('HistoryTmSnapshot', HistoryTmSnapshotSchema);
