/**
 * Etiqueta legible para logs de terminal: distingue sync granular del plan vs JSON masivo.
 */
export function getApiRequestKind(path: string, method: string): string {
  const m = method.toUpperCase();
  const p = path.replace(/\/$/, '') || '/';

  if (p.startsWith('/api/routines')) {
    if (p.endsWith('/plan') && m === 'PATCH') {
      return '[plan BULK] JSON completo (versions/baseTemplate…) — cliente viejo o fallback';
    }
    if (/\/exercises\/[^/]+$/.test(p) && m === 'PATCH') {
      return '[plan granular] PATCH ejercicio (una fila)';
    }
    if (/\/exercises\/[^/]+$/.test(p) && m === 'DELETE') {
      return '[plan granular] DELETE ejercicio';
    }
    if (/\/days\/[^/]+\/exercises\/?$/.test(p) && m === 'POST') {
      return '[plan granular] POST ejercicio en día';
    }
    if (/\/days\/[^/]+\/?$/.test(p) && m === 'PATCH' && !p.includes('/exercises')) {
      return '[plan granular] PATCH día (tipo/nombre)';
    }
    if (p.endsWith('/logs') && m === 'PATCH') {
      return '[logs] PATCH series/RPE (incremental)';
    }
    if (p.endsWith('/activate') && m === 'PUT') {
      return '[rutina] activar';
    }
    if (m === 'PUT' && /^\/api\/routines\/[^/]+$/.test(p)) {
      return '[rutina] PUT (nombre, flags, o plan si body trae template)';
    }
    if (m === 'POST' && (p === '/api/routines' || p === '/api/routines/')) {
      return '[rutina] POST crear (plan inicial en body)';
    }
    if (m === 'GET' && (p === '/api/routines' || p === '/api/routines/')) {
      return '[rutina] GET lista';
    }
    if (m === 'GET' && /^\/api\/routines\/[^/]+$/.test(p)) {
      return '[rutina] GET una';
    }
    if (m === 'DELETE' && /^\/api\/routines\/[^/]+$/.test(p)) {
      return '[rutina] DELETE';
    }
  }

  if (p.startsWith('/api/training-maxes')) {
    if (p.includes('/save-period')) return '[TM/historial] save-period';
    if (p.includes('/history')) return '[TM/historial] GET history';
    return '[training-maxes]';
  }

  if (p === '/health' || p === '/ping') return '[health]';

  return '[API]';
}

/** Tamaño del body sin volcar JSON (evita “paredes” de texto en la terminal). */
export function summarizeBodyHint(body: unknown): string {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return '';
  const keys = Object.keys(body as object);
  if (keys.length === 0) return '';
  if ('password' in (body as Record<string, unknown>) && (body as Record<string, unknown>).password) {
    return ' · body [pwd oculto]';
  }
  try {
    const raw = JSON.stringify(body);
    if (raw.length > 1200) {
      return ` · ~${Math.round(raw.length / 1024)}KB (${keys.length} keys)`;
    }
    return ` · ${raw.length}b`;
  } catch {
    return '';
  }
}

/** Una sola línea listo para `console` / `logger`; `null` si no conviene loguear (no es `/api`). */
export function formatApiRequestLogLine(path: string, method: string, body: unknown): string | null {
  const p = path || '';
  if (!p.startsWith('/api')) return null;
  const kind = getApiRequestKind(p, method);
  return `${kind} ${method} ${p}${summarizeBodyHint(body)}`;
}
