import { Friendship } from '../models/Friendship';
import { logger } from './logger';

/**
 * Antes un solo documento accepted (sin followOnly) era amistad.
 * El modelo nuevo pide las dos direcciones. Esta migración crea la inversa
 * para esas parejas antiguas y no toca follows de un solo lado (followOnly:true).
 * Idempotente: si la inversa ya existe accepted, no hace nada.
 */
export async function backfillLegacyMutualFriendships(): Promise<void> {
  const legacy = await Friendship.find({
    status: 'accepted',
    followOnly: { $ne: true },
  })
    .select('requester recipient createdAt')
    .lean();

  if (legacy.length === 0) return;

  let created = 0;
  let upgraded = 0;

  for (const row of legacy) {
    const requester = row.requester;
    const recipient = row.recipient;
    if (!requester || !recipient) continue;

    try {
      const reverse = await Friendship.findOne({ requester: recipient, recipient: requester });
      if (!reverse) {
        await Friendship.create({
          requester: recipient,
          recipient: requester,
          status: 'accepted',
          followOnly: false,
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        });
        created += 1;
        continue;
      }
      if (reverse.status !== 'accepted' || reverse.followOnly) {
        reverse.status = 'accepted';
        reverse.followOnly = false;
        await reverse.save();
        upgraded += 1;
      }
    } catch (e: unknown) {
      const code = (e as { code?: number } | null)?.code;
      if (code === 11000) continue;
      throw e;
    }
  }

  const normalized = await Friendship.updateMany(
    { status: 'accepted', followOnly: { $exists: false } },
    { $set: { followOnly: false } }
  );

  if (created > 0 || upgraded > 0 || normalized.modifiedCount > 0) {
    logger.info(
      `[migration] Amistades antiguas → bidireccionales: ${created} inversas creadas, ${upgraded} actualizadas, ${normalized.modifiedCount} campos alineados`
    );
  }
}
