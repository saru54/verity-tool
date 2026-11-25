import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import {
  ShardBrowserClient, chooseFingerprint, connectSession, proxyString, shardBrowserSettings,
} from '../src/browser/shardbrowser.js';
import { parseProxy } from '../src/core/proxy.js';

async function fakeLauncher(t, { token = 'test-token', behaviour = {} } = {}) {
  const calls = [];
  const cdp = 'cdp' in behaviour ? behaviour.cdp
    : { port: 1, http_url: 'http://127.0.0.1:1', web_socket_debugger_url: 'ws://127.0.0.1:1/devtools/browser/x' };
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const json = body.length ? JSON.parse(Buffer.concat(body).toString('utf8')) : null;
    calls.push({ method: request.method, path: request.url, body: json, authorization: request.headers.authorization });
    const unauthorized = request.url !== '/health' && request.headers.authorization !== `Bearer ${token}`;
    if (request.url === '/health') return send(response, 200, { ok: true, name: 'shardx-launcher', version: '2.1.5' });
    if (unauthorized) return send(response, 401, { error: 'unauthorized' });
    if (request.url === '/fingerprints') return send(response, 200, behaviour.fingerprints ?? [
      { id: 'win-gtx1650', platform: 'Windows', gpu: 'ANGLE (NVIDIA, GeForce GTX 1650 Laptop GPU)' },
      { id: 'win-rtx4080', platform: 'Windows', gpu: 'ANGLE (NVIDIA, GeForce RTX 4080)' },
      { id: 'mac-m4', platform: 'macOS', gpu: 'Apple M4' },
    ]);
    if (request.url === '/fingerprint/new/Windows' && !behaviour.noFingerprintRoute) {
      return send(response, 200, { fingerprint: { name: 'template', timezone: 'auto', geolocation: { mode: 'auto' },
        navigator: { user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', language: 'en-US', languages: ['en-US'] } } });
    }
    if (request.url === '/profiles' && json?.fingerprint) {
      return send(response, 200, { id: 'profile-1', name: json.name ?? 'custom', fingerprint_id: json.fingerprint.name, proxy_inline: Boolean(json.proxy) });
    }
    if (request.url === '/profiles/temporary') return send(response, 200, { id: 'profile-1', fingerprint_id: json?.fingerprint_id ?? 'win-gtx1650', temporary: true, proxy_inline: Boolean(json?.proxy) });
    if (request.url === '/profiles/profile-1/start') {
      if (behaviour.startError) return send(response, 500, { error: behaviour.startError });
      return send(response, 200, { profile_id: 'profile-1', pid: 10, headless: Boolean(json?.headless), cdp, cdp_error: null });
    }
    if (request.url === '/profiles/profile-1/stop') return send(response, 200, { profile_id: 'profile-1', stopped: true });
    if (request.url === '/profiles/profile-1' && request.method === 'DELETE') return send(response, 200, { deleted: true });
    return send(response, 404, { error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, calls };
}

function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function baseConfig(endpoint, extra = {}) {
  return {
    app: 'sheerid',
    url: 'https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=bbbbbbbbbbbbbbbbbbbbbbbb',
    proxy: null, shardBrowser: { endpoint, token: 'test-token' }, browser: { headless: false },
    timeouts: { actionMs: 1000, navigationMs: 1000 }, ...extra,
  };
}

test('ShardBrowser client sends its bearer key and fails closed', async t => {
  const { endpoint, calls } = await fakeLauncher(t);
  const client = new ShardBrowserClient({ endpoint, token: 'test-token' });
  assert.equal((await client.health()).name, 'shardx-launcher');
  assert.equal(calls[0].path, '/health');
  assert.equal(calls[0].authorization, 'Bearer test-token');
  await client.fingerprints();
  assert.equal(calls[1].authorization, 'Bearer test-token');

  const wrong = new ShardBrowserClient({ endpoint, token: 'wrong-key' });
  await assert.rejects(wrong.fingerprints(), { code: 'SHARDBROWSER_UNAUTHORIZED' });
  const offline = new ShardBrowserClient({ endpoint: 'http://127.0.0.1:1', token: 'x', timeoutMs: 1500 });
  await assert.rejects(offline.health(), { code: 'SHARDBROWSER_UNREACHABLE' });
});

test('Profile creation carries the Windows platform, fingerprint and proxy', async t => {
  const { endpoint, calls } = await fakeLauncher(t);
  const client = new ShardBrowserClient({ endpoint, token: 'test-token' });
  const profile = await client.createProfile({
    fingerprintId: 'win-gtx1650', proxy: proxyString(parseProxy('http://user:pa%40ss@127.0.0.1:8899')),
  });
  assert.equal(profile.id, 'profile-1');
  const created = calls.find(call => call.path === '/profiles/temporary');
  assert.equal(created.body.platform, 'Windows');
  assert.equal(created.body.fingerprint_id, 'win-gtx1650');
  assert.equal(created.body.proxy, 'http://user:pa%40ss@127.0.0.1:8899');
  assert.equal(created.body.headless, undefined, 'headless is a start option, not a profile field');
});

test('Launch rejects a profile without a debugging endpoint and keeps cleanup idempotent', async t => {
  const { endpoint } = await fakeLauncher(t, { behaviour: { cdp: null } });
  const client = new ShardBrowserClient({ endpoint, token: 'test-token' });
  await assert.rejects(client.startProfile('profile-1'), { code: 'INVALID_CONFIG' });
  assert.equal(await client.stopProfile('profile-missing'), null);
  assert.equal(await client.deleteProfile('profile-missing'), null);
});

test('Fingerprint choice stays on Windows and prefers laptop hardware', async t => {
  const { endpoint } = await fakeLauncher(t);
  const client = new ShardBrowserClient({ endpoint, token: 'test-token' });
  const settings = shardBrowserSettings(baseConfig(endpoint));
  for (let index = 0; index < 12; index++) {
    assert.equal(await chooseFingerprint(client, settings), 'win-gtx1650');
  }
  assert.equal(await chooseFingerprint(client, { ...settings, fingerprintId: 'win-rtx4080' }), 'win-rtx4080');
  const noWindows = await fakeLauncher(t, { behaviour: { fingerprints: [{ id: 'mac-m4', platform: 'macOS', gpu: 'Apple M4' }] } });
  await assert.rejects(chooseFingerprint(new ShardBrowserClient({ endpoint: noWindows.endpoint, token: 'test-token' }), settings),
    /没有 Windows 平台指纹/);
});

test('Proxy strings keep credentials and default SOCKS5 ports; direct stays empty', () => {
  assert.equal(proxyString(null), '');
  assert.equal(proxyString(false), '');
  assert.equal(proxyString(parseProxy('127.0.0.1:8899:user:pass')), 'http://user:pass@127.0.0.1:8899');
  assert.equal(proxyString(parseProxy('socks5://127.0.0.1')), 'socks5://127.0.0.1:1080');
  assert.equal(proxyString(parseProxy({ server: 'http://127.0.0.1:8899', username: 'u', password: 'p' })), 'http://u:p@127.0.0.1:8899');
});

test('Connect refuses missing keys, non-Windows platforms and dead debug ports', async t => {
  const config = baseConfig('http://127.0.0.1:1');
  await assert.rejects(connectSession({ config: { ...config, shardBrowser: { endpoint: config.shardBrowser.endpoint, token: '' } } }),
    { code: 'INVALID_CONFIG' });
  await assert.rejects(connectSession({ config: { ...config, shardBrowser: { ...config.shardBrowser, platform: 'macOS' } } }),
    /必须固定为 Windows/);

  const { endpoint, calls } = await fakeLauncher(t);
  // connectSession generates a custom English fingerprint (POST /profiles), starts it,
    // and fails at the CDP connect stage; cleanup must still stop and delete the profile.
    try {
      await connectSession({ config: baseConfig(endpoint) });
      assert.fail('connect should have failed on the dead debug port');
    } catch (error) {
      assert.equal(error.code, 'SHARDBROWSER_CDP_FAILED');
    }
  assert.ok(calls.some(call => call.path === '/profiles/profile-1/stop'), 'releases the profile');
  assert.ok(calls.some(call => call.path === '/profiles/profile-1' && call.method === 'DELETE'), 'deletes the temporary profile');
});
