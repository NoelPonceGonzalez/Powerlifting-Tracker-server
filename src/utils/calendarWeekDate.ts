function formatLocalDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function dateISOFromYearWeekDay(year: number, week: number, dayOfWeek: number): string {
  const start = new Date(year, 0, 1);
  for (let i = 0; i < 400; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    if (d.getFullYear() !== year) break;
    const diffDays = Math.floor((d.getTime() - new Date(year, 0, 1).getTime()) / 86400000);
    const w = Math.max(1, Math.min(52, Math.floor(diffDays / 7) + 1));
    const wd = (d.getDay() + 6) % 7;
    if (w === week && wd === dayOfWeek) {
      return formatLocalDateISO(d);
    }
  }
  const fallback = new Date(year, 0, 1);
  fallback.setDate(fallback.getDate() + (week - 1) * 7 + dayOfWeek);
  return formatLocalDateISO(fallback);
}

export function calendarMonth1FromDateISO(iso: string): number {
  const m = parseInt(iso.slice(5, 7), 10);
  return Number.isFinite(m) ? m : 1;
}
