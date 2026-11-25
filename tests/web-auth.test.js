import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebServer, parseAccounts } from '../src/web/server.js';
import { webConfig } from './fixtures/web-config.js';

const verificationId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const jobUrl = `https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=${verificationId}`;

async function startServer(t, options = {}) {
  const { configFile } = await webConfig(t);
  const app = createWebServer({
    port: 0, configFile,
    users: options.users ?? [{ username: 'fixture', password: 'fixture-pass' }],
    workflow: async config => ({ status: 'pending', url: config.url }),
    ...options,
  });
  const origin = await app.start();
  t.after(() => app.close());
  return { app, origin };
}

async function login(origin, { username = 'fixture', password = 'fixture-pass' } = {}) {
  const response = await fetch(`${origin}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json().catch(() => ({}));
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { status: response.status, body, cookie };
}

test('parseAccounts accepts explicit users, pair lists and hashed values', () => {
  const fromOption = parseAccounts({ users: [{ username: 'ops', password: 'plain-pass' }] });
  assert.equal(fromOption.size, 1);
  assert.equal(fromOption.has('ops'), true);
  assert.equal(fromOption.get('ops').length, 32);
  const fromEnv = parseAccounts({ env: { ONE_WEB_USERS: 'ops:plain-pass,audit:sha256:0000000000000000000000000000000000000000000000000000000000000000' } });
  assert.deepEqual([...fromEnv.keys()], ['ops', 'audit']);
  const single = parseAccounts({ password: 'legacy-pass' });
  assert.deepEqual([...single.keys()], ['admin'], 'ONE_WEB_PASSWORD alone maps to the admin account');
  assert.throws(() => parseAccounts({ env: { ONE_WEB_USERS: 'nodigest-field' } }), { code: 'INVALID_CONFIG' });
  assert.throws(() => parseAccounts({ users: [{ username: 'bad name!', password: 'long-enough' }] }), { code: 'INVALID_CONFIG' });
  assert.throws(() => parseAccounts({ users: [{ username: 'ops', password: 'x' }] }), { code: 'INVALID_CONFIG' });
});

test('The server refuses to start without any login account', async t => {
  const { configFile } = await webConfig(t);
  assert.throws(() => createWebServer({ port: 0, configFile, password: '' }), { code: 'INVALID_CONFIG' });
});

test('Every API route requires an account login; assets stay public', async t => {
  const { origin } = await startServer(t);
  for (const path of ['/', '/app.js', '/style.css']) {
    assert.equal((await fetch(origin + path)).status, 200, path);
  }
  for (const path of ['/api/session', '/api/jobs', '/api/materials', '/api/universities']) {
    assert.equal((await fetch(origin + path)).status, 401, path);
  }
  const wrong = await login(origin, { password: 'wrong-pass' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(wrong.cookie, '', 'a failed login must not set a session cookie');
  const unknown = await login(origin, { username: 'nobody', password: 'whatever-pass' });
  assert.equal(unknown.status, 401);
});

test('A successful login issues a session cookie plus write token', async t => {
  const { app, origin } = await startServer(t);
  const bad = await login(origin, { username: '', password: 'fixture-pass' });
  assert.equal(bad.status, 401);
  const session = await login(origin);
  assert.equal(session.status, 200);
  assert.match(session.cookie, /^one-session=[a-f\d]{64}$/);
  assert.equal(session.body.username, 'fixture');
  assert.equal(typeof session.body.token, 'string');
  // The cookie alone keeps reads working; writes still need the token.
  assert.equal((await fetch(`${origin}/api/jobs`, { headers: { Cookie: session.cookie } })).status, 200);
  assert.equal((await fetch(`${origin}/api/jobs`, { method: 'POST', headers: { Cookie: session.cookie } })).status, 403);
  const created = await fetch(`${origin}/api/jobs`, {
    method: 'POST', headers: { Cookie: session.cookie, 'X-Local-Token': session.body.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: jobUrl }),
  });
  assert.equal(created.status, 202);
  // Await the job so material generation completes before t.after cleanup.
  const { job } = await created.json();
  await app.jobs.jobs.get(job.id).done;
  // A forged or foreign session id is not a valid session.
  assert.equal((await fetch(origin + '/api/session', { headers: { Cookie: 'one-session=' + '0'.repeat(64) } })).status, 401);
});

test('Logout invalidates the session server-side', async t => {
  const { origin } = await startServer(t);
  const session = await login(origin);
  const headers = { Cookie: session.cookie, 'X-Local-Token': session.body.token };
  assert.equal((await fetch(origin + '/api/session', { headers })).status, 200);
  const logout = await fetch(origin + '/api/logout', { method: 'POST', headers });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.equal((await fetch(origin + '/api/session', { headers })).status, 401);
  assert.equal((await fetch(origin + '/api/logout', { method: 'POST', headers })).status, 401);
});

test('Repeated failures throttle the source before accepting a good login', async t => {
  const { origin } = await startServer(t);
  // First two failures answer 401 normally; the second one arms the throttle.
  const first = await login(origin, { password: 'wrong-1' });
  assert.equal(first.status, 401);
  assert.equal(first.body.error.code, 'INVALID_CREDENTIALS');
  const second = await login(origin, { password: 'wrong-2' });
  assert.equal(second.status, 401);
  // The third attempt is blocked even with the correct credentials.
  const throttled = await login(origin);
  assert.equal(throttled.status, 429);
  assert.equal(throttled.body.error.code, 'TOO_MANY_ATTEMPTS');
  assert.equal(throttled.cookie, '', 'a throttled attempt must not mint a session');
  // Backoff after the second failure is 200ms; afterwards the real credentials pass.
  await new Promise(resolve => setTimeout(resolve, 450));
  const recovered = await login(origin);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.username, 'fixture');
});

test('Bound hosts stay restricted when a public origin is configured', async t => {
  const { configFile } = await webConfig(t);
  const app = createWebServer({
    port: 0, configFile, host: '0.0.0.0', publicOrigin: 'https://workspace.example.com',
    users: [{ username: 'fixture', password: 'fixture-pass' }],
    workflow: async () => ({ status: 'pending' }),
  });
  await app.start();
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'workspace.example.com' },
    body: JSON.stringify({ username: 'fixture', password: 'fixture-pass' }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie') ?? '', /Secure/);
});
