/**
 * Same-origin requests plus an explicit allowlist, shared by the Node server
 * and the hosted Worker.
 *
 * The site itself can be served from more than one host (the hosted copy, the
 * GitHub Pages copy, localhost). Requests from those pages still have to reach
 * one backend, so the backend has to say yes to exactly those origins.
 */

const DEFAULT_ORIGINS = ['https://pinnaclebuilds1.github.io'];

export function allowedOriginSet(config = {}) {
  const extra = String(config.allowedOrigins || '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

/** { ok, origin } — ok is false for a foreign Origin header. */
export function checkOrigin(originHeader, requestUrl, config) {
  if (!originHeader) return { ok: true, origin: '' };

  let origin = '';
  try {
    origin = new URL(String(originHeader)).origin;
  } catch {
    return { ok: false, origin: '' };
  }

  if (origin === requestUrl.origin) return { ok: true, origin };
  if (allowedOriginSet(config).has(origin)) return { ok: true, origin };
  return { ok: false, origin: '' };
}

/** Headers that let an allowed page read the JSON answer. */
export function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
}
