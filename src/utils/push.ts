import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import { User } from '../models/User';

let expo: Expo | null = null;

function getExpo(): Expo {
  if (!expo) expo = new Expo();
  return expo;
}

/** Canal Android (debe coincidir con setNotificationChannelAsync('default', ...) en la app). */
const ANDROID_CHANNEL_ID = 'default';

/**
 * Expo / APNs: el objeto `data` debe usar valores serializables; en iOS los valores custom
 * suelen ir como strings — ver https://docs.expo.dev/push-notifications/sending-notifications/
 */
function buildPushDataPayload(data?: Record<string, any>): Record<string, string> {
  const type = String(data?.type ?? '');
  let tab: 'friends' | 'challenges' | 'checkins' = 'checkins';
  if (type === 'friend_request' || type === 'friend_accepted') {
    tab = 'friends';
  } else if (type === 'challenge_invite' || type === 'challenge_join') {
    tab = 'challenges';
  } else if (
    type === 'gym_checkin' ||
    type === 'same_time_confirmation' ||
    type === ''
  ) {
    tab = 'checkins';
  }

  const merged: Record<string, unknown> = {
    screen: 'social',
    tab,
    ...(data || {}),
  };
  merged.screen = 'social';
  merged.tab = tab;

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v == null) continue;
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    else out[k] = JSON.stringify(v);
  }
  return out;
}

/** Envía push a un usuario (Expo → FCM / APNs). */
export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<void> {
  try {
    const user = await User.findById(userId).select('pushToken');
    const token = user?.pushToken;
    if (!token || !Expo.isExpoPushToken(token)) {
      console.warn('[PUSH] Usuario sin token válido:', userId, '(build EAS + permisos + login)');
      return;
    }

    const client = getExpo();
    const message: ExpoPushMessage = {
      to: token,
      sound: 'default',
      title,
      body,
      channelId: ANDROID_CHANNEL_ID,
      data: buildPushDataPayload(data),
      priority: 'high' as const,
      ttl: 86400,
    };
    const tickets = await client.sendPushNotificationsAsync([message]);
    const ticket = tickets[0];
    if (ticket?.status === 'error') {
      console.error('[PUSH] Error ticket para', userId, (ticket as any).message);
    } else {
      console.log('[PUSH] Enviado a', userId, ':', title);
    }
  } catch (err) {
    console.error('[PUSH] Error enviando a usuario', userId, err);
  }
}

export async function sendPushToUsers(
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<void> {
  if (userIds.length === 0) return;
  const users = await User.find({ _id: { $in: userIds } }).select('pushToken');
  const tokens = users
    .map((u) => u.pushToken)
    .filter((t): t is string => !!t && typeof t === 'string' && t.trim().length > 0 && Expo.isExpoPushToken(t));

  const withoutToken = users.filter((u) => !u.pushToken || !Expo.isExpoPushToken(u.pushToken));
  if (withoutToken.length > 0) {
    console.warn(
      '[PUSH] Sin token válido:',
      withoutToken.map((u: any) => u._id?.toString())
    );
  }
  if (tokens.length === 0) {
    console.warn(
      '[PUSH] Ningún token válido. Requisitos: APK/IPA EAS (no Expo Go), permisos, sesión iniciada.'
    );
    return;
  }

  try {
    const client = getExpo();
    const payloadData = buildPushDataPayload(data);
    const messages: ExpoPushMessage[] = tokens.map((to) => ({
      to,
      sound: 'default',
      title,
      body,
      channelId: ANDROID_CHANNEL_ID,
      data: payloadData,
      priority: 'high' as const,
      ttl: 86400,
    }));
    const tickets = await client.sendPushNotificationsAsync(messages);
    const errors = tickets.filter((t: any) => t?.status === 'error');
    if (errors.length > 0) {
      console.error('[PUSH] Errores en envío:', errors.map((e: any) => (e as any).message));
    } else {
      console.log('[PUSH] Enviadas', tickets.length, 'notificaciones:', title);
    }
  } catch (err) {
    console.error('[PUSH] Error enviando a usuarios', err);
  }
}
