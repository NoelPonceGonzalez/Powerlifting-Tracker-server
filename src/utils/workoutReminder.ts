import { User } from '../models/User';
import { Routine } from '../models/Routine';
import { Notification } from '../models/Notification';
import { sendPushToUser } from './push';
import { logger } from './logger';

const INTERVAL_MS = 60 * 1000;

function partsInTz(tz: string) {
  const safe = tz && tz.length > 2 ? tz : 'Europe/Madrid';
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone: safe,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour12: false,
    });
  } catch {
    dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Madrid',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour12: false,
    });
  }
  const bag: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date())) {
    if (p.type !== 'literal') bag[p.type] = p.value;
  }
  const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(
    String(bag.weekday || '').toLowerCase().slice(0, 3)
  );
  return {
    hhmm: `${bag.hour}:${bag.minute}`,
    date: `${bag.year}-${bag.month}-${bag.day}`,
    weekday: weekday >= 0 ? weekday : new Date().getDay(),
  };
}

function normalizeTime(raw?: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '10:00').trim());
  if (!m) return '10:00';
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

async function todayIsRest(userId: string, weekday: number): Promise<boolean> {
  try {
    const routine = await Routine.findOne({ userId, isActive: true }).lean();
    if (!routine) return true;
    const { assembleFullRoutine } = await import('./assembleRoutine');
    const full = (await assembleFullRoutine(routine)) as {
      weeks?: Array<{ days?: Array<{ type?: string }> }>;
    };
    const week = full.weeks?.[0];
    const days = week?.days || [];
    if (days.length === 0) return false;
    const mondayFirst = weekday === 0 ? 6 : weekday - 1;
    const day = days[mondayFirst] || days[weekday] || days[0];
    return day?.type === 'rest';
  } catch {
    return false;
  }
}

export async function sweepWorkoutReminders(): Promise<number> {
  const users = await User.find({ workoutReminderOn: { $ne: false } })
    .select('name timezone workoutReminderTime workoutReminderDate')
    .limit(400)
    .lean();
  let sent = 0;
  for (const u of users) {
    const local = partsInTz(String(u.timezone || 'Europe/Madrid'));
    if (local.hhmm !== normalizeTime(u.workoutReminderTime)) continue;
    if (u.workoutReminderDate === local.date) continue;
    if (await todayIsRest(String(u._id), local.weekday)) {
      await User.updateOne({ _id: u._id }, { $set: { workoutReminderDate: local.date } });
      continue;
    }
    const title = 'Hoy toca entrenar';
    const message = `${u.name || 'Vamos'}, es tu hora.`;
    await Notification.create({
      userId: u._id,
      type: 'workout_reminder',
      title,
      message,
    });
    await sendPushToUser(String(u._id), title, message, {
      type: 'workout_reminder',
      screen: 'program',
    }).catch(() => {});
    await User.updateOne({ _id: u._id }, { $set: { workoutReminderDate: local.date } });
    sent += 1;
  }
  if (sent > 0) logger.info(`[reminder] ${sent} avisos de entreno`);
  return sent;
}

export function startWorkoutReminders(): NodeJS.Timeout {
  const run = () => {
    void sweepWorkoutReminders().catch(e => logger.warn('[reminder] barrida fallida', e));
  };
  const kick = setTimeout(run, 15_000);
  kick.unref?.();
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
  return timer;
}
