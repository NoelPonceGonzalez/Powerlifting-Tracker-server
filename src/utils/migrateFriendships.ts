/**
 * Antes un documento accepted se copiaba en las dos direcciones al arrancar.
 * Eso deshacía un «dejar de seguir»: al reiniciar volvía el follow.
 * Un follow es una sola dirección y no se recrea.
 */
export async function backfillLegacyMutualFriendships(): Promise<void> {
  return;
}
