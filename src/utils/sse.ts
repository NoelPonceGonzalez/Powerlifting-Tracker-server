import { Response } from 'express';

interface SseClient {
  userId: string;
  res: Response;
  lastPing: number;
}

const clients: Map<string, SseClient[]> = new Map();

const HEARTBEAT_INTERVAL = 25_000; // 25 s — keeps ALB / proxy alive

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function ensureHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [userId, arr] of clients.entries()) {
      const alive: SseClient[] = [];
      for (const c of arr) {
        try {
          c.res.write(`: heartbeat ${now}\n\n`);
          c.lastPing = now;
          alive.push(c);
        } catch {
          /* connection dead — drop */
        }
      }
      if (alive.length === 0) clients.delete(userId);
      else clients.set(userId, alive);
    }
    if (clients.size === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }, HEARTBEAT_INTERVAL);
}

export function addSseClient(userId: string, res: Response) {
  const client: SseClient = { userId, res, lastPing: Date.now() };
  const arr = clients.get(userId) ?? [];
  arr.push(client);
  clients.set(userId, arr);
  ensureHeartbeat();

  res.on('close', () => {
    const arr2 = clients.get(userId);
    if (!arr2) return;
    const filtered = arr2.filter(c => c !== client);
    if (filtered.length === 0) clients.delete(userId);
    else clients.set(userId, filtered);
  });
}

export type SseEventType =
  | 'social_update'    // friends, requests changed
  | 'checkin_update'   // gym check-ins changed
  | 'challenge_update' // tournaments changed
  | 'routine_update';  // TMs, routine data changed

/**
 * Broadcast an SSE event to specific users.
 * Non-blocking — fire and forget.
 */
export function broadcastSse(userIds: string[], event: SseEventType, data?: Record<string, unknown>) {
  const payload = JSON.stringify({ type: event, ...(data ?? {}) });
  const frame = `event: ${event}\ndata: ${payload}\n\n`;

  for (const uid of userIds) {
    const arr = clients.get(uid);
    if (!arr) continue;
    for (const c of arr) {
      try {
        c.res.write(frame);
      } catch {
        /* dead connection — heartbeat will clean up */
      }
    }
  }
}

/**
 * Broadcast to ALL connected clients (e.g. for global events).
 */
export function broadcastSseAll(event: SseEventType, data?: Record<string, unknown>) {
  const payload = JSON.stringify({ type: event, ...(data ?? {}) });
  const frame = `event: ${event}\ndata: ${payload}\n\n`;
  for (const arr of clients.values()) {
    for (const c of arr) {
      try {
        c.res.write(frame);
      } catch {
        /* dead */
      }
    }
  }
}

export function getSseClientCount(): number {
  let n = 0;
  for (const arr of clients.values()) n += arr.length;
  return n;
}
