/**
 * End-to-end check for the hosted (Worker + D1 + R2) build.
 *
 * Run a local copy first:
 *   npm run build:site
 *   npx wrangler dev --config wrangler.local.jsonc --port 8788 --var PB_ADMIN_PASSWORD:localtest123
 * then:
 *   node worker/smoke.mjs http://127.0.0.1:8788 localtest123
 *
 * The deploy check runs the same script against the public URL.
 */
import assert from 'node:assert/strict';

const base = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/$/, '');
const password = process.argv[3] || process.env.PB_TEST_PASSWORD || 'localtest123';
const email = process.env.PB_TEST_EMAIL || 'pinnaclebuilds1@gmail.com';
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

let passed = 0;

async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

async function api(body, init = {}) {
  const res = await fetch(`${base}/api`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    ...init
  });
  return { status: res.status, body: await res.json() };
}

await check('serves the site pointing at its own API', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /window\.PINNACLE_API = "\/api";/);
  assert.match(html, /Pinnacle Builds/);
});

await check('health reports the hosted engine', async () => {
  const res = await fetch(`${base}/api?action=health`);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.engine, 'edge');
});

await check('site loads from D1', async () => {
  const res = await fetch(`${base}/api?action=site`);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.ok(Array.isArray(json.builds));
  assert.ok(json.community && Array.isArray(json.community.feedback));
});

await check('the studio portfolio is seeded', async () => {
  const { body } = await api({ action: 'site' });
  const house = body.builds.find((b) => b.id === 'build-8bcb659b');
  assert.ok(house, 'the carried-over build should be public');
  assert.equal(house.cover.url, 'media/massive-fantasy-house.jpg');
});

await check('site media is published next to the site', async () => {
  const res = await fetch(`${base}/media/massive-fantasy-house.jpg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.ok((await res.arrayBuffer()).byteLength > 1000);
});

await check('the mirrored site origin may call the API', async () => {
  const res = await fetch(`${base}/api`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://pinnaclebuilds1.github.io' },
    body: JSON.stringify({ action: 'site' })
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://pinnaclebuilds1.github.io');
  assert.equal((await res.json()).ok, true);
});

await check('non-read GET actions are refused', async () => {
  const res = await fetch(`${base}/api?action=commission`);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.match(json.error, /Use POST/);
});

await check('cross-origin posts are blocked', async () => {
  const res = await api({ action: 'site' }, { headers: { 'content-type': 'text/plain', origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  assert.equal(res.body.ok, false);
});

await check('unknown actions still get a friendly error', async () => {
  const { body } = await api({ action: 'nope' });
  assert.equal(body.ok, false);
  assert.match(body.error, /Unknown request/);
});

let commissionId = '';

await check('guest commission is accepted and stored', async () => {
  const { body } = await api({
    action: 'commission',
    data: {
      name: 'Worker Test',
      email: 'worker@example.com',
      discord: 'workertest',
      type: 'House or building',
      size: '80 x 80',
      budget: '$25',
      idea: 'A lighthouse on a cliff edge.'
    }
  });
  assert.equal(body.ok, true);
  assert.match(body.ref, /^PB-[0-9A-F]{8}$/);
  commissionId = body.ref;
});

await check('public queue hides contact details', async () => {
  const { body } = await api({ action: 'publicCommissions' });
  assert.equal(body.ok, true);
  assert.ok(body.queue.some((row) => row.displayName === 'Worker Test'));
  assert.equal(JSON.stringify(body).includes('worker@example.com'), false);
});

await check('manager rejects a wrong password', async () => {
  const { body } = await api({ action: 'ownerLogin', email, password: `${password}-wrong` });
  assert.equal(body.ok, false);
});

let token = '';

await check('manager signs in with PB_ADMIN_PASSWORD', async () => {
  const { body } = await api({ action: 'ownerLogin', email, password });
  if (!body.ok && /not set up yet/.test(String(body.error))) {
    throw new Error('PB_ADMIN_PASSWORD is not set on this deployment.');
  }
  assert.equal(body.ok, true, body.error);
  assert.ok(body.token.length > 20);
  token = body.token;
});

await check('manager sees the commission', async () => {
  const { body } = await api({ action: 'admin', token, op: 'load' });
  assert.equal(body.ok, true);
  const row = body.commissions.find((item) => item.id === commissionId);
  assert.ok(row, 'new commission should be in the inbox');
  assert.equal(row.email, 'worker@example.com');
});

let coverUrl = '';

await check('uploads are stored in R2 and served', async () => {
  const created = await api({ action: 'admin', token, op: 'saveBuild', payload: { build: { title: 'Edge Keep', category: 'Castle or fortress', tags: 'edge, keep' } } });
  assert.equal(created.body.ok, true);
  const buildId = created.body.id;

  const uploaded = await api({
    action: 'admin',
    token,
    op: 'upload',
    payload: { buildId, kind: 'cover', name: 'keep.jpg', data: PNG_1X1 }
  });
  assert.equal(uploaded.body.ok, true, uploaded.body.error);
  coverUrl = uploaded.body.site.builds.find((b) => b.id === buildId).cover.url;
  assert.match(coverUrl, /^\/uploads\/[0-9a-f-]{36}\.jpg$/);

  const file = await fetch(`${base}${coverUrl}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/jpeg');
  assert.ok((await file.arrayBuffer()).byteLength > 50);

  const removed = await api({ action: 'admin', token, op: 'deleteBuild', payload: { id: buildId } });
  assert.equal(removed.body.ok, true);
  const gone = await fetch(`${base}${coverUrl}`);
  assert.equal(gone.status, 404);
});

await check('private paths are not published', async () => {
  for (const path of ['/server/api.mjs', '/worker/index.mjs', '/sites.manifest.json', '/.env']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, `${path} should not be served`);
  }
});

await check('moderation and settings save to D1', async () => {
  const submitted = await api({ action: 'publicFeedback', data: { displayName: 'Edge Fan', message: 'The edge build is great.' } });
  assert.equal(submitted.body.ok, true);

  const pending = await api({ action: 'admin', token, op: 'community' });
  const item = pending.body.community.feedback.find((row) => row.message.includes('edge build'));
  assert.ok(item);

  const approved = await api({ action: 'admin', token, op: 'moderateCommunity', payload: { kind: 'feedback', id: item.id, approved: true } });
  assert.equal(approved.body.ok, true);

  const settings = await api({ action: 'admin', token, op: 'saveSettings', payload: { settings: { heroLine1: 'Public build,', open: 'true' } } });
  assert.equal(settings.body.ok, true);

  const site = await api({ action: 'site' });
  assert.equal(site.body.settings.heroLine1, 'Public build,');
  assert.ok(site.body.community.feedback.some((row) => row.displayName === 'Edge Fan'));
  assert.equal(site.body.community.feedback[0].email, undefined);
});

await check('cleanup: commission archived, session signed out', async () => {
  const archived = await api({ action: 'admin', token, op: 'updateCommission', payload: { id: commissionId, archived: true } });
  assert.equal(archived.body.ok, true);
  const out = await api({ action: 'ownerLogout', token });
  assert.equal(out.body.ok, true);
  const after = await api({ action: 'admin', token, op: 'load' });
  assert.equal(after.body.signedOut, true);
});

console.log(`\n${passed} checks passed against ${base}`);
