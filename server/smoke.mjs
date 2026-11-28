/**
 * End-to-end check for the studio server.
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './index.mjs';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const OWNER_EMAIL = 'owner@example.com';
const OWNER_PASSWORD = 'smoke-test-password';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinnacle-smoke-'));
const started = await startServer({
  PB_ADMIN_EMAIL: OWNER_EMAIL,
  PB_ADMIN_PASSWORD: OWNER_PASSWORD,
  PB_DATA_DIR: dataDir,
  PORT: '0',
  quiet: true
});
const base = started.url;
let passed = 0;

async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

async function api(body) {
  const res = await fetch(`${base}/api`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

try {
  await check('serves the site with its own API injected', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /window\.PINNACLE_API = "\/api";/);
    assert.match(html, /Pinnacle Builds/);
  });

  await check('GET ?action=site works', async () => {
    const res = await fetch(`${base}/api?action=site`);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.builds));
    assert.ok(json.settings && typeof json.settings === 'object');
    assert.equal(json.community.feedback.length, 0);
  });

  await check('the studio portfolio is seeded', async () => {
    const res = await fetch(`${base}/api?action=site`);
    const json = await res.json();
    const house = json.builds.find((b) => b.id === 'build-8bcb659b');
    assert.ok(house, 'the carried-over build should be public');
    assert.equal(house.title, 'Massive Fantasy House');
    assert.equal(house.cover.url, 'media/massive-fantasy-house.jpg');
  });

  await check('site media files are served', async () => {
    const res = await fetch(`${base}/media/massive-fantasy-house.jpg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.ok((await res.arrayBuffer()).byteLength > 1000);
  });

  await check('the mirrored site origin may call the API, other sites may not', async () => {
    const allowed = await fetch(`${base}/api`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8', origin: 'https://pinnaclebuilds1.github.io' },
      body: JSON.stringify({ action: 'site' })
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://pinnaclebuilds1.github.io');

    const blocked = await fetch(`${base}/api`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8', origin: 'https://evil.example' },
      body: JSON.stringify({ action: 'site' })
    });
    assert.equal(blocked.status, 403);
  });

  await check('rejects unknown actions', async () => {
    const { body } = await api({ action: 'nope' });
    assert.equal(body.ok, false);
    assert.match(body.error, /Unknown request/);
  });

  let commissionId = '';

  await check('guest commission validation', async () => {
    const bad = await api({ action: 'commission', data: { name: 'Sam' } });
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.error, /required fields/);
    const badEmail = await api({
      action: 'commission',
      data: { name: 'Sam', email: 'nope', discord: 'sam', idea: 'A castle' }
    });
    assert.match(badEmail.body.error, /valid email/);
  });

  await check('guest commission is accepted', async () => {
    const { body } = await api({
      action: 'commission',
      data: {
        name: 'Sam',
        email: 'sam@example.com',
        discord: 'samcraft',
        type: 'House or building',
        platform: 'Windows / PC',
        size: '100 x 100',
        budget: '$40',
        idea: 'A cozy wizard tower with a library inside.'
      }
    });
    assert.equal(body.ok, true);
    assert.match(body.ref, /^PB-[0-9A-F]{8}$/);
    commissionId = body.ref;
  });

  await check('public queue shows the new request without contact details', async () => {
    const { body } = await api({ action: 'publicCommissions' });
    assert.equal(body.ok, true);
    assert.equal(body.commissions.length, 0);
    const queued = body.queue.find((q) => q.displayName === 'Sam');
    assert.ok(queued, 'request should be in the public queue');
    assert.equal(JSON.stringify(body).includes('sam@example.com'), false);
  });

  await check('manager routes require a session', async () => {
    const { body } = await api({ action: 'admin', token: 'nope', op: 'load' });
    assert.equal(body.ok, false);
    assert.equal(body.signedOut, true);
  });

  await check('wrong password is refused', async () => {
    const { body } = await api({ action: 'ownerLogin', email: OWNER_EMAIL, password: 'wrong' });
    assert.equal(body.ok, false);
    assert.match(body.error, /do not match/);
  });

  let token = '';
  await check('owner password login returns a token', async () => {
    const { body } = await api({ action: 'ownerLogin', email: OWNER_EMAIL, password: OWNER_PASSWORD });
    assert.equal(body.ok, true);
    assert.equal(body.role, 'owner');
    assert.ok(body.token.length > 20);
    token = body.token;
  });

  await check('manager load returns commissions and site', async () => {
    const { body } = await api({ action: 'admin', token, op: 'load' });
    assert.equal(body.ok, true);
    assert.equal(body.commissions.length, 1);
    assert.equal(body.commissions[0].id, commissionId);
    assert.equal(body.commissions[0].email, 'sam@example.com');
    assert.ok(body.site);
  });

  await check('commission can be quoted, marked done and given public details', async () => {
    const quoted = await api({
      action: 'admin',
      token,
      op: 'updateCommission',
      payload: { id: commissionId, status: 'Quoted', quote: '$40', notes: 'Sounds fun.' }
    });
    assert.equal(quoted.body.ok, true);
    assert.equal(quoted.body.commissions[0].status, 'Quoted');

    const badStatus = await api({
      action: 'admin',
      token,
      op: 'updateCommission',
      payload: { id: commissionId, status: 'Nonsense' }
    });
    assert.equal(badStatus.body.ok, false);

    const done = await api({
      action: 'admin',
      token,
      op: 'updateCommission',
      payload: {
        id: commissionId,
        status: 'Done',
        completedTitle: 'Wizard Tower',
        completedPrice: '$40',
        completedTime: '9 hours',
        completedDetails: 'Three floors of shelves and a spiral stair.'
      }
    });
    assert.equal(done.body.ok, true);
    assert.equal(done.body.commissions[0].completedTitle, 'Wizard Tower');
  });

  await check('completed commission appears publicly without private fields', async () => {
    const { body } = await api({ action: 'publicCommissions' });
    assert.equal(body.commissions.length, 1);
    const item = body.commissions[0];
    assert.equal(item.title, 'Wizard Tower');
    assert.equal(item.gmail, undefined);
    assert.equal(item.notes, undefined);
    assert.equal(item.thread, undefined);
    assert.equal(body.queue.length, 0);
  });

  await check('reply is recorded and returns a Gmail compose link', async () => {
    const { body } = await api({
      action: 'admin',
      token,
      op: 'reply',
      payload: { id: commissionId, subject: 'Your tower', message: 'Hey Sam, starting today.' }
    });
    assert.equal(body.ok, true);
    const row = body.commissions.find((c) => c.id === commissionId);
    assert.equal(row.thread.length, 1);
    assert.equal(row.thread[0].text, 'Hey Sam, starting today.');
    assert.match(body.gmailUrl, /^https:\/\/mail\.google\.com\/mail\/\?view=cm/);
  });

  await check('completed pictures upload and are served publicly', async () => {
    const { body } = await api({
      action: 'admin',
      token,
      op: 'uploadCommissionImage',
      payload: { id: commissionId, name: 'tower.jpg', data: PNG_1X1 }
    });
    assert.equal(body.ok, true);
    const row = body.commissions.find((c) => c.id === commissionId);
    assert.equal(row.completedGallery.length, 1);
    const url = row.completedGallery[0].url;
    assert.match(url, /^\/uploads\/[0-9a-f-]{36}\.jpg$/);

    const file = await fetch(`${base}${url}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/jpeg');
    assert.ok((await file.arrayBuffer()).byteLength > 50);

    const pub = await api({ action: 'publicCommissions' });
    assert.equal(pub.body.commissions[0].gallery.length, 1);
  });

  await check('guest feedback is held for review, then published', async () => {
    const submit = await api({
      action: 'publicFeedback',
      data: { displayName: 'Alex', message: 'The dragon build is unreal.' }
    });
    assert.equal(submit.body.ok, true);

    const before = await api({ action: 'site' });
    assert.equal(before.body.community.feedback.length, 0);

    const pending = await api({ action: 'admin', token, op: 'community' });
    const item = pending.body.community.feedback.find((f) => f.message.includes('dragon'));
    assert.ok(item);
    assert.equal(item.approved, false);

    const approved = await api({
      action: 'admin',
      token,
      op: 'moderateCommunity',
      payload: { kind: 'feedback', id: item.id, approved: true }
    });
    assert.equal(approved.body.ok, true);

    const after = await api({ action: 'site' });
    assert.equal(after.body.community.feedback.length, 1);
    assert.equal(after.body.community.feedback[0].displayName, 'Alex');
    assert.equal(after.body.community.feedback[0].email, undefined);
  });

  await check('referrals are moderated separately', async () => {
    const submit = await api({ action: 'publicReferral', data: { displayName: 'Kai', message: 'Try Sam for redstone.' } });
    assert.equal(submit.body.ok, true);
    const pending = await api({ action: 'admin', token, op: 'community' });
    const item = pending.body.community.referrals[0];
    const removed = await api({
      action: 'admin',
      token,
      op: 'moderateCommunity',
      payload: { kind: 'referral', id: item.id, remove: true }
    });
    assert.equal(removed.body.community.referrals.length, 0);
  });

  let buildId = '';
  await check('builds can be created, uploaded to and deleted', async () => {
    const created = await api({
      action: 'admin',
      token,
      op: 'saveBuild',
      payload: { build: { title: 'Test Keep', category: 'Castle or fortress', tagline: 'A test keep.', tags: 'test, keep' } }
    });
    assert.equal(created.body.ok, true);
    buildId = created.body.id;
    assert.ok(buildId);

    const built = created.body.site.builds.find((b) => b.id === buildId);
    assert.deepEqual(built.tags, ['test', 'keep']);

    const uploaded = await api({
      action: 'admin',
      token,
      op: 'upload',
      payload: { buildId, kind: 'cover', name: 'keep.jpg', data: PNG_1X1 }
    });
    assert.equal(uploaded.body.ok, true);
    const cover = uploaded.body.site.builds.find((b) => b.id === buildId).cover;
    assert.match(cover.url, /^\/uploads\//);

    const badKind = await api({
      action: 'admin',
      token,
      op: 'upload',
      payload: { buildId, kind: 'cover', name: 'evil.html', data: Buffer.from('<script>alert(1)</script>').toString('base64') }
    });
    assert.equal(badKind.body.ok, false);

    const deleted = await api({ action: 'admin', token, op: 'deleteBuild', payload: { id: buildId } });
    assert.equal(deleted.body.ok, true);
    assert.equal(deleted.body.site.builds.some((b) => b.id === buildId), false);
    const gone = await fetch(`${base}${cover.url}`);
    assert.equal(gone.status, 404);
  });

  await check('homepage settings and featured builds are saved', async () => {
    const saved = await api({
      action: 'admin',
      token,
      op: 'saveSettings',
      payload: { settings: { heroLine1: 'Build with me,', open: 'false', closedNote: 'Back soon.', bogus: 'ignored' } }
    });
    assert.equal(saved.body.ok, true);
    assert.equal(saved.body.site.settings.heroLine1, 'Build with me,');
    assert.equal(saved.body.site.settings.open, 'false');
    assert.equal(saved.body.site.settings.bogus, undefined);

    const featured = await api({ action: 'admin', token, op: 'saveFeatured', payload: { ids: ['deadly-nadder', 'timber-manor'] } });
    assert.equal(featured.body.ok, true);
    assert.deepEqual(featured.body.site.featured, ['deadly-nadder', 'timber-manor']);
  });

  await check('logout invalidates the session', async () => {
    const out = await api({ action: 'ownerLogout', token });
    assert.equal(out.body.ok, true);
    const after = await api({ action: 'admin', token, op: 'load' });
    assert.equal(after.body.signedOut, true);
  });

  await check('private files and traversal are not served', async () => {
    for (const bad of ['/server/api.mjs', '/.env', '/Code.gs', '/package.json']) {
      const res = await fetch(`${base}${bad}`);
      assert.equal(res.status, 404, `${bad} should not be served`);
    }
  });

  await check('data survives a restart', async () => {
    await started.close();
    const again = await startServer({
      PB_ADMIN_EMAIL: OWNER_EMAIL,
      PB_ADMIN_PASSWORD: OWNER_PASSWORD,
      PB_DATA_DIR: dataDir,
      PORT: '0',
      quiet: true
    });
    try {
      const res = await fetch(`${again.url}/api?action=publicCommissions`);
      const json = await res.json();
      assert.equal(json.commissions.length, 1);
      const login = await fetch(`${again.url}/api`, {
        method: 'POST',
        body: JSON.stringify({ action: 'ownerLogin', email: OWNER_EMAIL, password: OWNER_PASSWORD })
      });
      assert.equal((await login.json()).ok, true);
    } finally {
      await again.close();
    }
  });

  console.log(`\n${passed} checks passed.`);
} catch (err) {
  console.error('\nFAILED:', err && err.message ? err.message : err);
  process.exitCode = 1;
  try {
    await started.close();
  } catch {}
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
