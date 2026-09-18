import { Notification, type NotificationType } from '../models/Notification';
import { sendPushToUser, sendPushToUsers } from './push';
import { broadcastSse, type SseEventType } from './sse';

export async function notifyUser(opts: {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  relatedUserId?: string;
  relatedData?: Record<string, unknown>;
  sse?: SseEventType;
}): Promise<void> {
  await Notification.create({
    userId: opts.userId,
    type: opts.type,
    title: opts.title,
    message: opts.message,
    relatedUserId: opts.relatedUserId,
    relatedData: opts.relatedData,
  });
  try {
    await sendPushToUser(opts.userId, opts.title, opts.message, {
      type: opts.type,
      relatedUserId: opts.relatedUserId,
      ...(opts.relatedData || {}),
    });
  } catch (e) {
    console.error(`[PUSH] Error ${opts.type}:`, e);
  }
  if (opts.sse) broadcastSse([String(opts.userId)], opts.sse);
}

export async function notifyUsers(opts: {
  userIds: string[];
  type: NotificationType;
  title: string;
  message: string;
  relatedUserId?: string;
  relatedData?: Record<string, unknown>;
  sse?: SseEventType;
}): Promise<void> {
  const ids = [...new Set(opts.userIds.map(String).filter(Boolean))];
  if (ids.length === 0) return;
  await Notification.insertMany(
    ids.map(userId => ({
      userId,
      type: opts.type,
      title: opts.title,
      message: opts.message,
      relatedUserId: opts.relatedUserId,
      relatedData: opts.relatedData,
    }))
  );
  try {
    await sendPushToUsers(ids, opts.title, opts.message, {
      type: opts.type,
      relatedUserId: opts.relatedUserId,
      ...(opts.relatedData || {}),
    });
  } catch (e) {
    console.error(`[PUSH] Error ${opts.type}:`, e);
  }
  if (opts.sse) broadcastSse(ids, opts.sse);
}
