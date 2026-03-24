import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import { User } from '../models/User';

let expo: Expo | null = null;

function getExpo(): Expo {
  if (!expo) expo = new Expo();
  return expo;
}

/** Canal Android para que las notificaciones se muestren correctamente */
const ANDROID_CHANNEL_ID = 'default';

/** Datos para que al pulsar la notificación se abra Social > Actividad */
const NAV_DATA = { screen: 'social', tab: 'checkins' };

/** Envía push a un usuario (llega al móvil aunque la app esté cerrada, como Instagram/WhatsApp) */
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
      console.warn('[PUSH] Usuario sin token válido:', userId, '(debe usar build real, no Expo Go, y haber iniciado sesión)');
      return;
    }

    const client = getExpo();
    const message: ExpoPushMessage = {
      to: token,
      sound: 'default',
      title,
      body,
      channelId: ANDROID_CHANNEL_ID,
      data: { ...NAV_DATA, ...(data || {}) },
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
    .map(u => u.pushToken)
    .filter((t): t is string => !!t && typeof t === 'string' && t.trim().length > 0 && Expo.isExpoPushToken(t));

  const withoutToken = users.filter(u => !u.pushToken || !Expo.isExpoPushToken(u.pushToken));
  if (withoutToken.length > 0) {
    console.warn('[PUSH] Usuarios sin token válido (deben abrir la app en build real, no Expo Go):', withoutToken.map((u: any) => u._id?.toString()));
  }
  if (tokens.length === 0) {
    console.warn('[PUSH] No hay tokens válidos para enviar. Los amigos deben:', 
      '1) Usar un APK/IPA de producción (eas build), NO Expo Go', 
      '2) Haber abierto la app y aceptado permisos de notificaciones',
      '3) Haber iniciado sesión para registrar el token');
    return;
  }

  try {
    const client = getExpo();
    const messages: ExpoPushMessage[] = tokens.map(to => ({
      to,
      sound: 'default',
      title,
      body,
      channelId: ANDROID_CHANNEL_ID,
      data: { ...NAV_DATA, ...(data || {}) },
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
