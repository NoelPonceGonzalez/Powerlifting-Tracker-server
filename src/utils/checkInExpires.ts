/**
 * Hora a la que MongoDB debe borrar el check-in: 3 h después de la hora de entreno
 * del día del registro (misma fecha que `timestamp`, hora = `time` HH:MM).
 */
export function computeCheckInExpiresAt(referenceDay: Date, timeHHMM: string): Date {
  const parts = timeHHMM.split(':').map((p) => parseInt(p, 10));
  const h = Number.isFinite(parts[0]) ? parts[0] : 0;
  const m = Number.isFinite(parts[1]) ? parts[1] : 0;
  const d = new Date(referenceDay);
  d.setHours(h, m, 0, 0);
  d.setTime(d.getTime() + 3 * 60 * 60 * 1000);
  return d;
}
