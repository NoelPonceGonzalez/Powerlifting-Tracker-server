import webpush from 'web-push';
import { User } from '../models/User';

export type WebPushSub = {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string } | null;
};

let configured = false;

function vapidPublic(): string {
  return process.env.VAPID_PUBLIC_KEY?.trim() || '';
}

function vapidPrivate(): string {
  return process.env.VAPID_PRIVATE_KEY?.trim() || '';
}

export function isWebPushConfigured(): boolean {
  return vapidPublic().length > 0 && vapidPrivate().length > 0;
}

export function getVapidPublicKey(): string {
  return vapidPublic();
}

function ensureConfigured(): boolean {
  if (configured) return true;
  const pub = vapidPublic();
  const priv = vapidPrivate();
  if (!pub || !priv) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT?.trim() || 'mailto:noreply@powerliftingtracker.com',
    pub,
    priv
  );
  configured = true;
  return true;
}

function usableSubs(user: { webPushSubscriptions?: WebPushSub[] | null }): WebPushSub[] {
  return (user.webPushSubscriptions || []).filter(
    (s): s is WebPushSub =>
      !!s?.endpoint && !!s.keys?.p256dh && !!s.keys?.auth
  );
}

function urlFromPayload(data?: Record<string, string>): string {
  const screen = data?.screen || 'dashboard';
  if (screen === 'program') return '/?pwa=plan';
  if (screen === 'social') {
    const tab = data?.tab || 'chat';
    return `/?pwa=social&tab=${encodeURIComponent(tab)}`;
  }
  return '/?pwa=dashboard';
}

async function dropDeadEndpoints(userId: string, endpoints: string[]): Promise<void> {
  if (!userId || endpoints.length === 0) return;
  await User.findByIdAndUpdate(userId, {
    $pull: { webPushSubscriptions: { endpoint: { $in: endpoints } } },
  });
}

export async function sendWebPushToUser(
  userId: string,
  user: { webPushSubscriptions?: WebPushSub[] | null },
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  if (!ensureConfigured()) return;
  const subs = usableSubs(user);
  if (subs.length === 0) return;

  const payload = JSON.stringify({
    title,
    body,
    tag: data?.type || 'activity',
    url: urlFromPayload(data),
    screen: data?.screen,
    tab: data?.tab,
    icon: '/icons/icon-192.png',
  });

  const dead: string[] = [];
  let sent = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys!.p256dh!, auth: sub.keys!.auth! },
          },
          payload,
          { TTL: 86400, urgency: 'high' }
        );
        sent += 1;
      } catch (err: any) {
        const status = err?.statusCode ?? err?.status;
        const detail = typeof err?.body === 'string' ? err.body.slice(0, 200) : err?.message;
        if (status === 404 || status === 410 || status === 403) {
          dead.push(sub.endpoint);
          console.warn('[WEB-PUSH] Suscripción inválida', userId, status, detail);
          return;
        }
        console.error('[WEB-PUSH] Error enviando a', userId, status || err?.message, detail);
      }
    })
  );

  if (dead.length > 0) {
    await dropDeadEndpoints(userId, dead);
    console.warn('[WEB-PUSH] Suscripciones caducadas quitadas:', dead.length);
  }
  if (sent > 0) {
    console.log('[WEB-PUSH] Enviado a', userId, `(${sent} nav.):`, title);
  }
}
