#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { Api } from './api.mjs';
import { hashPassword, verifyPassword, isPasswordHash } from './auth.mjs';
import { checkOrigin, corsHeaders } from './cors.mjs';
import { seedDatabase } from './seed.mjs';

// Node 18 does not always expose Web Crypto globally; auth.mjs needs it.
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  const { webcrypto } = await import('node:crypto');
  globalThis.crypto = webcrypto;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 42 * 1024 * 1024; // uploads arrive as base64 JSON

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mcstructure': 'application/octet-stream',
  '.mcworld': 'application/zip',
  '.zip': 'application/zip'
};

const UPLOAD_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mcstructure': 'application/octet-stream',
  '.mcworld': 'application/zip',
  '.zip': 'application/zip'
};

/** Minimal .env reader: KEY=VALUE lines, never overrides a real env variable. */
export function loadEnvFile(file, target = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return target;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (target[key] === undefined) target[key] = value;
  }
  return target;
}

export function makeConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const dataDir = path.resolve(ROOT, env.PB_DATA_DIR || 'server/data');
  return {
    root: ROOT,
    dataDir,
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    ownerEmail: String(env.PB_ADMIN_EMAIL || 'pinnaclebuilds1@gmail.com').trim().toLowerCase(),
    adminPassword: String(env.PB_ADMIN_PASSWORD || ''),
    googleClientId: String(env.PB_GOOGLE_CLIENT_ID || '').trim(),
    allowedOrigins: String(env.PB_ALLOWED_ORIGINS || '').trim(),
    publicApi: String(env.PB_PUBLIC_API || '').trim(),
    sessionTtlMs: 1000 * 60 * 60 * 12,
    quiet: !!overrides.quiet
  };
}

async function bootstrapAdmin(store, config) {
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

  if (config.adminPassword) {
    const usable = isPasswordHash(db.admin.passwordHash);
    if (!usable || !(await verifyPassword(config.adminPassword, db.admin.passwordHash))) {
      db.admin.passwordHash = await hashPassword(config.adminPassword);
      changed = true;
    }
  } else if (!db.admin.passwordHash || !isPasswordHash(db.admin.passwordHash)) {
    // No password configured, or one written by an older build: make a new one.
    const password = crypto.randomBytes(9).toString('base64url');
    db.admin.passwordHash = await hashPassword(password);
    const file = path.join(config.dataDir, 'ADMIN-PASSWORD.txt');
    fs.writeFileSync(file, `Pinnacle Builds studio sign-in\nemail: ${db.admin.email}\npassword: ${password}\n`, {
      mode: 0o600
    });
    config.generatedPasswordFile = file;
    changed = true;
  }

  if (seedDatabase(db)) changed = true;

  if (changed) await store.save();
}

function origin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('That upload is too large (30 MB max).'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra
  });
  res.end(body);
}

function sendFile(res, file, { cache = 'no-cache', type } = {}) {
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'content-type': type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin'
  });
  fs.createReadStream(file).pipe(res);
}

/** Serve the single-page site, pointing it at this server's own API. */
function sendIndex(res, projectRoot, apiUrl) {
  let html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  const injected = `window.PINNACLE_API = ${JSON.stringify(apiUrl)};`;
  if (/window\.PINNACLE_API\s*=\s*"[^"]*";/.test(html)) {
    html = html.replace(/window\.PINNACLE_API\s*=\s*"[^"]*";/, injected);
  } else {
    html = html.replace('<head>', `<head>\n<script>${injected}</script>`);
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin'
  });
  res.end(html);
}

function blockedStaticPath(relative) {
  const normalized = relative.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('.')) return true;
  if (normalized.includes('..')) return true;
  const first = normalized.split('/')[0];
  if (['server', 'node_modules', '.git', '.github', '.freebuff'].includes(first)) return true;
  if (normalized === '.env' || normalized.startsWith('.env')) return true;
  if (['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].includes(normalized)) return true;
  if (normalized === 'Code.gs' || normalized === 'apps-script' || first === 'apps-script') return true;
  return false;
}

async function handleApi(req, res, { api, config, url, ip, cors }) {
  // Cross-site posts are refused unless the origin is on the allowlist.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  let payload;
  if (req.method === 'POST') {
    const raw = await readBody(req);
    const trimmed = raw.trim();
    if (!trimmed) payload = {};
    else {
      try {
        payload = JSON.parse(trimmed);
      } catch {
        sendJson(res, 200, { ok: false, error: 'The request body was not valid JSON.' });
        return;
      }
    }
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    const action = url.searchParams.get('action') || '';
    const readOnly = ['site', 'publicCommissions', 'health'];
    if (!readOnly.includes(action)) {
      sendJson(res, 200, { ok: false, error: 'Use POST for this action.' });
      return;
    }
    payload = { action };
  } else {
    sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
    return;
  }

  try {
    const result = await api.handle(payload, { ip });
    sendJson(res, 200, { ok: true, ...(result || {}) }, cors);
  } catch (err) {
    const status = err && err.status ? err.status : 200;
    const body = {
      ok: false,
      error: (err && err.message ? String(err.message) : 'Something went wrong.').slice(0, 400)
    };
    if (err && err.signedOut) body.signedOut = true;
    if (!config.quiet && status >= 500) console.error('[api]', err);
    sendJson(res, status, body, cors);
  }
}

export async function startServer(overrides = {}) {
  if (!overrides.env) loadEnvFile(path.join(ROOT, '.env'));
  const config = makeConfig(overrides);
  fs.mkdirSync(config.dataDir, { recursive: true });

  const store = new Store(config.dataDir);
  await bootstrapAdmin(store, config);
  const api = new Api(store, config);

  const server = http.createServer(async (req, res) => {
    const originUrl = origin(req);
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      (req.socket && req.socket.remoteAddress) || 'unknown';

    try {
      const url = new URL(req.url || '/', originUrl);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === '/api' || pathname === '/api/') {
        const check = checkOrigin(req.headers.origin, url, config);
        if (!check.ok) {
          sendJson(res, 403, { ok: false, error: 'Cross-origin requests are not allowed.' });
          return;
        }
        await handleApi(req, res, { api, config, url, ip, cors: corsHeaders(check.origin) });
        return;
      }

      if (pathname.startsWith('/uploads/')) {
        const file = store.uploadPath(pathname.slice('/uploads/'.length));
        if (!file) {
          sendJson(res, 404, { ok: false, error: 'File not found.' });
          return;
        }
        const ext = path.extname(file).toLowerCase();
        sendFile(res, file, { cache: 'public, max-age=31536000, immutable', type: UPLOAD_TYPES[ext] || 'application/octet-stream' });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return;
      }

      if (pathname === '/' || pathname === '/index.html') {
        // A relative API path works on any host and protocol (localhost, previews, HTTPS).
        sendIndex(res, config.root, config.publicApi || '/api');
        return;
      }

      const relative = pathname.replace(/^\/+/, '');
      if (blockedStaticPath(relative)) {
        sendJson(res, 404, { ok: false, error: 'Not found.' });
        return;
      }
      const file = path.join(config.root, relative);
      if (!file.startsWith(config.root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        sendJson(res, 404, { ok: false, error: 'Not found.' });
        return;
      }
      sendFile(res, file);
    } catch (err) {
      console.error('[server]', err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Unexpected server error.' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  return {
    server,
    config,
    store,
    api,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const started = await startServer();
  const { config, url } = started;
  console.log('');
  console.log('  Pinnacle Builds studio server');
  console.log(`  Site:    ${url}`);
  console.log(`  Manager: ${url}/#manager`);
  console.log(`  Login:   ${config.ownerEmail}`);
  if (config.generatedPasswordFile) {
    console.log(`  Password: generated — saved in ${path.relative(config.root, config.generatedPasswordFile)}`);
    console.log('            (set PB_ADMIN_PASSWORD to choose your own)');
  } else {
    console.log('  Password: the PB_ADMIN_PASSWORD from your environment or .env file');
  }
  console.log(`  Data:    ${path.relative(config.root, config.dataDir)}/`);
  console.log('');
}
