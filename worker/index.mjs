/**
 * Hosted build of the Pinnacle Builds studio server.
 *
 * Serves the same /api actions as server/index.mjs, backed by Cloudflare D1
 * (database) and R2 (uploads), with the site itself delivered as static assets.
 */
import { Api } from '../server/api.mjs';
import { hashPassword, isPasswordHash } from '../server/auth.mjs';
import { emptyDatabase } from '../server/schema.mjs';
import { EdgeStore, CONTENT_TYPES, UPLOAD_PATTERN } from './store.mjs';
import { checkOrigin, corsHeaders } from '../server/cors.mjs';
import { seedDatabase } from '../server/seed.mjs';

const MAX_BODY = 42 * 1024 * 1024;
/* Flood and password-guessing counters outlive one request: a fresh Api per
   request would otherwise start with empty buckets and limit nothing. */
const sharedLimits = { rateBuckets: new Map(), loginFailures: new Map() };
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const READ_ONLY_ACTIONS = ['site', 'publicCommissions', 'health'];

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff'
};

const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers });

function makeConfig(env) {
  return {
    ownerEmail: String(env.PB_ADMIN_EMAIL || 'pinnaclebuilds1@gmail.com').trim().toLowerCase(),
    adminPassword: String(env.PB_ADMIN_PASSWORD || ''),
    googleClientId: String(env.PB_GOOGLE_CLIENT_ID || '').trim(),
    sessionTtlMs: SESSION_TTL_MS,
    allowedOrigins: String(env.PB_ALLOWED_ORIGINS || ''),
    runtime: 'edge',
    quiet: true
  };
}

/* ------------------------------------------------------------------ storage */

let schemaReady = null;

async function ensureSchema(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS studio (id INTEGER PRIMARY KEY, body TEXT NOT NULL, rev INTEGER NOT NULL, updated TEXT NOT NULL)'
  ).run();
  await env.DB.prepare('INSERT OR IGNORE INTO studio (id, body, rev, updated) VALUES (1, ?, 0, ?)')
    .bind(JSON.stringify(emptyDatabase()), new Date().toISOString())
    .run();
}

function ready(env) {
  if (!schemaReady) {
    schemaReady = ensureSchema(env).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function load(env) {
  const row = await env.DB.prepare('SELECT body, rev FROM studio WHERE id = 1').first();
  let stored = null;
  try {
    stored = row && row.body ? JSON.parse(row.body) : null;
  } catch {
    stored = null;
  }
  return {
    data: { ...emptyDatabase(), ...(stored || {}) },
    rev: row ? Number(row.rev) || 0 : 0
  };
}

async function commit(env, store) {
  if (!store.dirty) return true;
  const result = await env.DB.prepare('UPDATE studio SET body = ?, rev = rev + 1, updated = ? WHERE id = 1 AND rev = ?')
    .bind(JSON.stringify(store.data), new Date().toISOString(), store.rev)
    .run();
  const changes = result && result.meta ? Number(result.meta.changes) || 0 : 0;
  if (changes < 1) return false;
  store.dirty = false;
  await store.finalize();
  return true;
}

/** First-run setup + expiry cleanup, kept cheap enough to run per request. */
async function prepare(store, config) {
  const db = store.db;
  let changed = false;

  if (!db.admin || typeof db.admin !== 'object') {
    db.admin = { email: config.ownerEmail, passwordHash: '', createdAt: new Date().toISOString() };
    changed = true;
  }
  if (db.admin.email !== config.ownerEmail) {
    db.admin.email = config.ownerEmail;
    changed = true;
  }
  // PB_ADMIN_PASSWORD is hashed the first time it appears (or when it changes format).
  if (config.adminPassword && !isPasswordHash(db.admin.passwordHash)) {
    db.admin.passwordHash = await hashPassword(config.adminPassword);
    changed = true;
  }

  const cutoff = Date.now();
  const sessions = Array.isArray(db.sessions) ? db.sessions : [];
  const live = sessions.filter((session) => Date.parse((session && session.expires) || 0) > cutoff);
  if (live.length !== sessions.length) {
    db.sessions = live;
    changed = true;
  }

  if (seedDatabase(db)) changed = true;

  if (changed) await store.save();
}

/* ---------------------------------------------------------------------- api */

async function handleApi(request, env, config) {
  const url = new URL(request.url);

  let payload;
  if (request.method === 'POST') {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_BODY) return json(413, { ok: false, error: 'That upload is too large (30 MB max).' });

    const raw = await request.text();
    if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'That upload is too large (30 MB max).' });
    const trimmed = raw.trim();
    if (!trimmed) {
      payload = {};
    } else {
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return json(200, { ok: false, error: 'The request body was not valid JSON.' });
      }
    }
  } else if (request.method === 'GET' || request.method === 'HEAD') {
    const action = url.searchParams.get('action') || '';
    if (!READ_ONLY_ACTIONS.includes(action)) {
      return json(200, { ok: false, error: 'Use POST for this action.' });
    }
    payload = { action };
  } else {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }

  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ready(env);
    const { data, rev } = await load(env);
    const store = new EdgeStore({ db: data, rev, bucket: env.FILES });
    const api = new Api(store, config);
    api.rateBuckets = sharedLimits.rateBuckets;
    api.loginFailures = sharedLimits.loginFailures;

    try {
      await prepare(store, config);
      const result = await api.handle(payload, { ip });
      const committed = await commit(env, store);
      if (!committed) {
        await store.discard();
        continue;
      }
      return json(200, { ok: true, ...(result || {}) });
    } catch (err) {
      await store.discard();
      const status = err && err.status ? err.status : 200;
      const body = {
        ok: false,
        error: (err && err.message ? String(err.message) : 'Something went wrong.').slice(0, 400)
      };
      if (err && err.signedOut) body.signedOut = true;
      return json(status, body);
    }
  }

  return json(503, { ok: false, error: 'The studio is busy right now. Please try again in a moment.' });
}

/* ----------------------------------------------------------------- uploads */

async function handleUpload(request, env, name) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }
  if (!UPLOAD_PATTERN.test(name)) return json(404, { ok: false, error: 'File not found.' });

  const object = await env.FILES.get(name);
  if (!object) return json(404, { ok: false, error: 'File not found.' });

  const ext = `.${name.split('.').pop().toLowerCase()}`;
  return new Response(request.method === 'HEAD' ? null : object.body, {
    headers: {
      'content-type': (object.httpMetadata && object.httpMetadata.contentType) || CONTENT_TYPES[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff'
    }
  });
}

/* ------------------------------------------------------------------- entry */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/api' || pathname === '/api/') {
      const config = makeConfig(env);
      const origin = checkOrigin(request.headers.get('origin'), new URL(request.url), config);
      if (!origin.ok) return json(403, { ok: false, error: 'Cross-origin requests are not allowed.' });

      const cors = corsHeaders(origin.origin);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

      let response;
      try {
        response = await handleApi(request, env, config);
      } catch (err) {
        console.error('[api]', err);
        response = json(500, { ok: false, error: 'Unexpected server error.' });
      }

      const keys = Object.keys(cors);
      if (!keys.length) return response;
      const allowed = new Response(response.body, response);
      for (const key of keys) allowed.headers.set(key, cors[key]);
      return allowed;
    }

    if (pathname.startsWith('/uploads/')) {
      try {
        return await handleUpload(request, env, pathname.slice('/uploads/'.length));
      } catch (err) {
        console.error('[uploads]', err);
        return json(500, { ok: false, error: 'Unexpected server error.' });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
