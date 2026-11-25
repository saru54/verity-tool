import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createWebServer } from '../src/web/server.js';
import { webConfig } from './fixtures/web-config.js';

const publicOrigin = 'https://workspace.example.com';
const username = 'ops';
const password = 'fixture-password-for-offline-tests';

test('Public deployment requires a login account and an explicit HTTPS origin', () => {
  assert.throws(() => createWebServer({ publicOrigin, password: '' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => createWebServer({ publicOrigin: 'http://workspace.example.com', password }), { code: 'INVALID_CONFIG' });
});

test('Public HTTPS origin authenticates by login, keeps CSRF protections and supports queue requests', async t => {
  let app;
  t.after(() => app?.close());
  const { configFile } = await webConfig(t);
  app = createWebServer({ port: 0, host: '0.0.0.0', publicOrigin,
    users: [{ username, password }], configFile,
    workflow: async () => ({ status: 'pending' }) });
  await app.start();
  const call = (path, headers = {}, body) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: app.server.address().port, path,
      method: body ? 'POST' : 'GET', headers: { Host: 'workspace.example.com', ...headers } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    req.on('error', reject); req.end(body);
  });
  for (const path of ['/', '/app.js', '/style.css']) {
    const asset = await call(path);
    assert.equal(asset.status, 200, path);
    assert.ok(!asset.text.includes(password));
  }
  // Unauthenticated API access and forged sessions are rejected before any data flows.
  assert.equal((await call('/api/session')).status, 401);
  assert.equal((await call('/api/jobs')).status, 401);
  const deniedOrigin = await call('/api/login', {
    'Content-Type': 'application/json', Origin: 'https://evil.example',
  }, JSON.stringify({ username, password }));
  assert.equal(deniedOrigin.status, 403, 'cross-site login attempts are refused by the origin check');
  const wrong = await call('/api/login', { 'Content-Type': 'application/json' },
    JSON.stringify({ username, password: 'not-the-password' }));
  assert.equal(wrong.status, 401);
  assert.equal(JSON.parse(wrong.text).error.code, 'INVALID_CREDENTIALS');
  const session = await call('/api/login', { 'Content-Type': 'application/json' },
    JSON.stringify({ username, password }));
  assert.equal(session.status, 200);
  const cookie = session.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  const sessionCookie = cookie.split(';')[0];
  assert.equal((await call('/api/session', { Cookie: sessionCookie })).status, 200);
  assert.equal((await call('/api/jobs', { Cookie: sessionCookie })).status, 200);
  const { token } = JSON.parse(session.text);
  const body = JSON.stringify({ url: 'https://my.sheerid.com/rest/v2/verification/aaaaaaaaaaaaaaaaaaaaaaaa',
    firstName: 'Test', lastName: 'Student', birthDate: '2000-01-02' });
  const headers = { Cookie: sessionCookie, Origin: publicOrigin, 'Content-Type': 'application/json', 'X-Local-Token': token };
  assert.equal((await call('/api/jobs', { 'X-Local-Token': token, 'Content-Type': 'application/json' }, body)).status, 401);
  assert.equal((await call('/api/jobs', headers, body)).status, 202);
  assert.equal((await call('/api/jobs', { ...headers, Host: `localhost:${app.server.address().port}` }, body)).status, 202);
  assert.equal((await call('/api/jobs', { ...headers, Host: `127.0.0.1:${app.server.address().port}` }, body)).status, 202);
  assert.equal((await call('/api/jobs', { ...headers, Host: `localhost:${app.server.address().port}`, Origin: 'https://evil.example' }, body)).status, 403);
  assert.equal((await call('/api/jobs', { ...headers, Origin: 'https://evil.example' }, body)).status, 403);
  assert.equal((await call('/api/jobs', { ...headers, 'X-Local-Token': 'wrong' }, body)).status, 403);
  assert.equal((await call('/api/jobs', { ...headers, Host: 'evil.example' })).status, 403);
  assert.equal((await call('/api/jobs', { ...headers, 'Sec-Fetch-Site': 'cross-site' }, body)).status, 403);
  assert.equal((await call('/config/sheerid.local.json', { Cookie: sessionCookie })).status, 404);
});
