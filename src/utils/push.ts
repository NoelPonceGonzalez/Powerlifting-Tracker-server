import { Expo, ExpoPushMessage, ExpoPushTicket, ExpoPushReceiptId } from 'expo-server-sdk';
import { User } from '../models/User';
import { sendWebPushToUser } from './webPush';

let expo: Expo | null = null;

function getExpo(): Expo {
  if (!expo) {
    const accessToken = process.env.EXPO_ACCESS_TOKEN?.trim();
    expo = accessToken ? new Expo({ accessToken }) : new Expo();
    if (accessToken) {
      console.log('[PUSH] Expo client inicializado con accessToken (enhanced security)');
    } else {
      console.warn(
        '[PUSH] Sin EXPO_ACCESS_TOKEN — la entrega es menos fiable. ' +
        'Genera uno en https://expo.dev/accounts/_/settings/access-tokens'
      );
    }
  }
  return expo;
}

const ANDROID_CHANNEL_ID = 'default';

/** Tokens Expo válidos en `pushTokens` (varios dispositivos). */
export function collectValidExpoTokens(user: {
  pushTokens?: string[] | null;
}): string[] {
  const raw = (user.pushTokens || []).filter(
    (x): x is string => typeof x === 'string' && x.trim().length > 0
  );
  const valid = raw.filter((t) => Expo.isExpoPushToken(t));
  return [...new Set(valid)];
}

/**
 * Metadatos para deep link al pulsar la notificación (WebView + nativo).
 * - `screen`: dashboard = Progreso; program = Rutina/plan; social = Comunidad (usa `tab`).
 * Tipos sin pantalla concreta → solo abrir la app en Progreso.
 */
function buildPushDataPayload(data?: Record<string, any>): Record<string, string> {
  const type = String(data?.type ?? '');

  let screen: 'dashboard' | 'program' | 'social' = 'dashboard';
  let tab: 'friends' | 'challenges' | 'checkins' | 'chat' = 'checkins';

  if (type === 'new_rm') {
    screen = 'dashboard';
  } else if (type === 'friend_request' || type === 'friend_accepted') {
    screen = 'social';
    tab = 'friends';
  } else if (type === 'challenge_invite' || type === 'challenge_join' || type === 'challenge_winner') {
    screen = 'social';
    tab = 'challenges';
  } else if (type === 'gym_checkin' || type === 'same_time_confirmation') {
    screen = 'social';
    tab = 'checkins';
  } else if (type === 'chat_message') {
    screen = 'social';
    tab = 'chat';
  } else if (
    type === 'chat_request' ||
    type === 'group_invite' ||
    type === 'post_like' ||
    type === 'post_comment' ||
    type === 'post_comment_reply' ||
    type === 'coach_request' ||
    type === 'coach_accepted'
  ) {
    screen = 'social';
    tab = 'friends';
  } else if (type === '') {
    screen = 'dashboard';
  } else {
    screen = 'dashboard';
  }

  const merged: Record<string, unknown> = {
    ...(data || {}),
    screen,
    tab,
  };

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v == null) continue;
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    else out[k] = JSON.stringify(v);
  }
  return out;
}

// Receipt checking queue — Expo recomienda verificar recibos 15 min después
const pendingReceipts: ExpoPushReceiptId[] = [];
let receiptTimerRunning = false;

async function checkReceipts() {
  if (pendingReceipts.length === 0) return;
  const client = getExpo();
  const batch = pendingReceipts.splice(0, 300);
  try {
    const receipts = await client.getPushNotificationReceiptsAsync(batch);
    for (const [id, receipt] of Object.entries(receipts)) {
      if (receipt.status === 'error') {
        const { message, details } = receipt as any;
        console.error('[PUSH RECEIPT]', id, message, details?.error);
        if ((details as any)?.error === 'DeviceNotRegistered') {
          console.warn('[PUSH] DeviceNotRegistered — token inválido (ticket)', id);
        }
      }
    }
  } catch (err) {
    console.error('[PUSH RECEIPT] Error verificando recibos:', err);
    pendingReceipts.push(...batch);
  }
}

function scheduleReceiptCheck() {
  if (receiptTimerRunning) return;
  receiptTimerRunning = true;
  setTimeout(async () => {
    receiptTimerRunning = false;
    await checkReceipts();
    if (pendingReceipts.length > 0) scheduleReceiptCheck();
  }, 15 * 60 * 1000); // 15 min (recomendado por Expo)
}

function collectTicketIds(tickets: ExpoPushTicket[]) {
  for (const ticket of tickets) {
    if (ticket.status === 'ok' && ticket.id) {
      pendingReceipts.push(ticket.id);
    }
  }
  if (pendingReceipts.length > 0) scheduleReceiptCheck();
}

export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<void> {
  try {
    const user = await User.findById(userId).select('pushTokens webPushSubscriptions');
    const tokens = user ? collectValidExpoTokens(user) : [];
    const payloadData = buildPushDataPayload(data);

    if (tokens.length > 0) {
      const client = getExpo();
      const messages: ExpoPushMessage[] = tokens.map((to) => ({
        to,
        sound: 'default',
        title,
        body,
        channelId: ANDROID_CHANNEL_ID,
        data: payloadData,
        priority: 'high',
        ttl: 86400,
        badge: 1,
      }));
      const chunks = client.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        const tickets = await client.sendPushNotificationsAsync(chunk);
        collectTicketIds(tickets);
        const errors = tickets.filter((t: any) => t?.status === 'error');
        if (errors.length > 0) {
          console.error('[PUSH] Error ticket para', userId, errors.map((e: any) => (e as any).message));
        } else {
          console.log('[PUSH] Enviado a', userId, `(${tokens.length} disp.):`, title);
        }
      }
    } else if (!user?.webPushSubscriptions?.length) {
      console.warn('[PUSH] Usuario sin token Expo ni Web Push:', userId);
    }

    if (user) {
      await sendWebPushToUser(userId, user, title, body, payloadData);
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
  const users = await User.find({ _id: { $in: userIds } }).select('pushTokens webPushSubscriptions');
  const allTokens = users.flatMap((u) => collectValidExpoTokens(u));
  const tokens = [...new Set(allTokens)];

  const withoutChannel = users.filter(
    (u) => collectValidExpoTokens(u).length === 0 && !(u.webPushSubscriptions || []).length
  );
  if (withoutChannel.length > 0) {
    console.warn(
      '[PUSH] Sin Expo ni Web Push:',
      withoutChannel.map((u: any) => u._id?.toString())
    );
  }
  if (allTokens.length !== tokens.length) {
    console.log(`[PUSH] Dedup: ${allTokens.length} → ${tokens.length} tokens únicos (multi-cuenta mismo dispositivo)`);
  }

  const payloadData = buildPushDataPayload(data);

  if (tokens.length > 0) {
    try {
      const client = getExpo();
      const messages: ExpoPushMessage[] = tokens.map((to) => ({
        to,
        sound: 'default',
        title,
        body,
        channelId: ANDROID_CHANNEL_ID,
        data: payloadData,
        priority: 'high' as const,
        ttl: 86400,
        badge: 1,
      }));
      const chunks = client.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        const tickets = await client.sendPushNotificationsAsync(chunk);
        collectTicketIds(tickets);
        const errors = tickets.filter((t: any) => t?.status === 'error');
        if (errors.length > 0) {
          console.error('[PUSH] Errores en envío:', errors.map((e: any) => ({ msg: (e as any).message, details: (e as any).details })));
        } else {
          console.log('[PUSH] Enviadas', tickets.length, 'notificaciones:', title);
        }
      }
    } catch (err) {
      console.error('[PUSH] Error enviando a usuarios', err);
    }
  }

  await Promise.all(
    users.map((u) => sendWebPushToUser(String(u._id), u, title, body, payloadData))
  );
}
