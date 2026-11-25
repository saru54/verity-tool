import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { createWebServer } from '../src/web/server.js';
import { createLogger } from '../src/core/logger.js';
import { webConfig } from './fixtures/web-config.js';

const fetch = (url, options = {}) => globalThis.fetch(url, { ...options,
  headers: { ...options.headers } });

const url = 'https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=bbbbbbbbbbbbbbbbbbbbbbbb';
const input = (extra = {}) => ({ url, firstName: 'PrivateFirst', lastName: 'PrivateLast', birthDate: '2000-01-02', ...extra });
async function fixture(t, options = {}) {
  const { configFile, raw } = await webConfig(t);
  const app = createWebServer({
    port: 0, configFile,
    users: [{ username: 'fixture', password: 'fixture-pass' }],
    ...options,
  });
  const origin = await app.start();
  t.after(() => app.close());
  const login = await globalThis.fetch(`${origin}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'fixture', password: 'fixture-pass' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await login.json();
  const request = async (path, body, extra = {}) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { Cookie: cookie, 'X-Local-Token': session.token, 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const start = async body => {
    const response = await request('/api/jobs', body);
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
    const { job } = await response.json();
    await app.jobs.jobs.get(job.id).done;
    return app.jobs.get(job.id);
  };
  return { app, origin, request, start, cookie, token: session.token, configFile, raw };
}

test('Web serves assets, protects writes and does not expose saved settings', async t => {
  const { origin, request, cookie } = await fixture(t);
  for (const path of ['/', '/app.js', '/style.css']) assert.equal((await fetch(origin + path)).status, 200);
  // Unauthenticated reads are rejected now that every route requires a login.
  assert.equal((await fetch(origin + '/api/jobs')).status, 401);
  assert.equal((await fetch(origin + '/api/jobs', { method: 'POST' })).status, 401);
  assert.equal((await fetch(origin + '/api/session', { headers: { Origin: 'https://evil.example' } })).status, 403);
  // Writes with a valid session but without the page token still get 403.
  assert.equal((await fetch(origin + '/api/jobs', { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  assert.equal((await request('/api/jobs', input(), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/jobs', input(), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fetch(origin + '/config/sheerid.local.json', { headers: { Cookie: cookie } })).status, 404);
});

test('Web uses request fields with fresh settings and ignores removed direct proxy endpoints', async t => {
  let received, options;
  const { start, request, configFile, raw } = await fixture(t, { workflow: async (config, opts) => {
    received = config; options = opts;
    createLogger('fixture')('stage_started', { stage: 'fill', data: config.data });
    return { status: 'pending', data: config.data };
  } });
  // Direct proxy settings endpoints were removed; only provider settings remain.
  assert.equal((await request('/api/settings/proxy')).status, 404);
  const previous = { url: process.env.AUTOMATION_URL, proxy: process.env.AUTOMATION_PROXY };
  process.env.AUTOMATION_URL = 'https://wrong.example';
  process.env.AUTOMATION_PROXY = 'invalid://wrong';
  t.after(() => {
    for (const [key, value] of [['AUTOMATION_URL', previous.url], ['AUTOMATION_PROXY', previous.proxy]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const taskUrl = url.replace('bbbbbbbbbbbbbbbbbbbbbbbb', '1'.padStart(24, '0'));
  const snapshot = await start(input({ url: taskUrl }));
  assert.equal(received.url, taskUrl);
  assert.equal(received.data.firstName, 'PrivateFirst');
  assert.equal(received.data.lastName, 'PrivateLast');
  assert.equal(received.data.birthDate, '2000-01-02');
  assert.equal(received.data.email, `privatefirst.privatelast@${received.data.organization.emailDomain}`);
  // The organisation and country now come from the generated US university.
  assert.equal(received.data.country, 'United States');
  assert.match(received.data.organization.name, /University|Institute|College/);
  assert.equal(received.data.organization.optionText, received.data.organization.name);
  assert.equal(received.data.consent, raw.data.consent);
  assert.deepEqual(received.document, raw.document);
  assert.deepEqual(received.selectors, raw.selectors);
  assert.equal(received.timeouts.readyMs, raw.timeouts.readyMs);
  assert.equal(received.browser.locale, raw.browser.locale);
  assert.equal(received.interaction.keyDelayMs.min, raw.interaction.keyDelayMs.min);
  assert.equal(options.submit, true);
  assert.deepEqual(received.proxy, { server: 'http://127.0.0.1:7777', username: 'saved-user', password: 'saved-secret' });
  // Identity is intentionally queryable now; saved configuration secrets must stay hidden.
  assert.doesNotMatch(JSON.stringify(snapshot), /saved-secret|saved-user|saved@example/);
  raw.data.organization.emailDomain = 'example.edu';
  raw.browser = { ...raw.browser, headless: false, keepOpen: true, autoFill: false };
  await writeFile(configFile, JSON.stringify(raw));
  await start(input());
  assert.equal(received.data.email, `privatefirst.privatelast@${received.data.organization.emailDomain}`);
  assert.equal(received.browser.autoFill, false);
  assert.equal(options.submit, false);
});

test('Repeated verification URL submissions each get distinct random task IDs; cancellation preserves uncertainty', async t => {
  const attempts = [];
  const { app, origin, request, cookie } = await fixture(t, { workflow: async (_config, options) => {
    attempts.push(options);
    const { signal } = options;
    const log = createLogger('fixture');
    log('run_finished', { status: 'submission_unknown', code: 'RESULT_UNKNOWN' });
    log('browser_kept_open', { stage: 'await_user_close' });
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const response = await request('/api/jobs', input());
  const { job } = await response.json();
  assert.equal(response.status, 202);
  assert.match(job.id, /^[a-f\d]{24}$/);
  assert.notEqual(job.id, 'bbbbbbbbbbbbbbbbbbbbbbbb');
  const second = await request('/api/jobs', input());
  assert.equal(second.status, 202);
  const secondPayload = await second.json();
  assert.notEqual(secondPayload.job.id, job.id);
  assert.equal(secondPayload.deduplicated, undefined);
  const state = await (await fetch(`${origin}/api/jobs/${job.id}?after=1`, { headers: { Cookie: cookie } })).json();
  assert.equal(state.job.stage, 'await_user_close');
  // material_ready, web_queued, web_started and the workflow's own records.
  assert.ok(state.events.length >= 4);
  assert.deepEqual(state.events.slice(0, 3).map(event => event.event), ['material_ready', 'web_queued', 'web_started']);
  const queue = await (await fetch(`${origin}/api/jobs`, { headers: { Cookie: cookie } })).json();
  assert.equal(queue.jobs[0].id, job.id);
  assert.equal(queue.running, 1);
  assert.equal((await request(`/api/jobs/${job.id}/cancel`)).status, 200);
  await app.jobs.jobs.get(job.id).done;
  assert.equal(app.jobs.get(job.id).job.state, 'cancelled');
  assert.equal(app.jobs.get(job.id).job.result.status, 'submission_unknown');
  assert.equal((await request(`/api/jobs/${job.id}/resume`, undefined, { 'X-Local-Token': '' })).status, 403);
  const resumed = await request(`/api/jobs/${job.id}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).job.state, 'queued');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].jobId, job.id);
  assert.equal(attempts[1].jobId, secondPayload.job.id);
  assert.equal(app.jobs.jobs.size, 2);
  await request(`/api/jobs/${secondPayload.job.id}/cancel`);
  await app.jobs.jobs.get(secondPayload.job.id).done;
});

test('Rejects invalid input or extra settings without running workflow', async t => {
  let called = false;
  const { request, start } = await fixture(t, { workflow: async () => { called = true; throw new Error('secret-password'); } });
  for (const body of [null, {}, input({ url: 'https://evil.example' }), input({ proxy: 'http://127.0.0.1:8899' }), input({ config: {} }),
    input({ extra: 'invalid' }), input({ document: { path: 'C:/secret.pdf' } }), input({ url: undefined }),
    input({ birthDate: '2000-13-40' }), input({ universityId: 'Bad Id' }), input({ reuseMaterials: 'yes' }),
    input({ firstName: 'OnlyFirst', lastName: '' })]) {
    assert.equal((await request('/api/jobs', body)).status, 400);
  }
  assert.equal(called, false);
  const state = await start(input());
  assert.equal(state.job.state, 'failed');
  assert.equal(state.job.result.code, 'WEB_WORKFLOW_ERROR');
  assert.doesNotMatch(JSON.stringify(state), /secret-password/);
});

test('Web starts with no task-specific fields in settings and never writes submitted values back', async t => {
  let received;
  const { start, configFile, raw } = await fixture(t, { workflow: async config => { received = config; return { status: 'verified' }; } });
  delete raw.url;
  for (const key of ['firstName', 'lastName', 'email', 'birthDate']) delete raw.data[key];
  await writeFile(configFile, JSON.stringify(raw));
  await start(input());
  assert.equal(received.url, url);
  assert.equal(received.data.email, `privatefirst.privatelast@${received.data.organization.emailDomain}`);
  assert.equal(received.data.firstName, 'PrivateFirst');
  assert.equal(received.data.lastName, 'PrivateLast');
  assert.equal(received.data.birthDate, '2000-01-02');
  const { readFile } = await import('node:fs/promises');
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), raw);
});

test('DELETE removes finished jobs, protects writes, and allows explicit readmission', async t => {
  const { origin, start, cookie, token } = await fixture(t, { workflow: async () => ({ status: 'verified' }) });
  const { job } = await start(input());
  const path = `${origin}/api/jobs/${job.id}`;
  const headers = { Cookie: cookie, 'X-Local-Token': token };
  assert.equal((await fetch(path, { method: 'DELETE', headers: { Cookie: cookie } })).status, 403);
  assert.equal((await fetch(path, { method: 'DELETE', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(path, { headers: { Cookie: cookie } })).status, 200);
  const removed = await fetch(`${origin}/api/jobs/${job.id.toUpperCase()}`, { method: 'DELETE', headers });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { id: job.id, deleted: true });
  assert.equal((await fetch(path, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(path, { method: 'DELETE', headers })).status, 404);
  assert.equal((await (await fetch(`${origin}/api/jobs`, { headers: { Cookie: cookie } })).json()).jobs.length, 0);
  const added = await start(input());
  assert.notEqual(added.job.id, job.id);
  assert.equal(added.job.state, 'completed');
});

test('Web persists DataImpulse credentials without state-targeting flag', async t => {
  const { origin, cookie, token, configFile } = await fixture(t);
  const put = (body) => fetch(`${origin}/api/settings/dataimpulse`, {
    method: 'PUT', headers: { Cookie: cookie, 'X-Local-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const get = () => fetch(`${origin}/api/settings/dataimpulse`, { headers: { Cookie: cookie } });
  const saved = await put({ dataimpulse: {
    host: 'gw.dataimpulse.com', port: 12345, username: 'di-user', password: 'di-pass', useStateTargeting: true,
  } });
  assert.equal(saved.status, 200);
  const { readFile } = await import('node:fs/promises');
  const onDisk = JSON.parse(await readFile(configFile, 'utf8')).dataimpulse;
  assert.equal(onDisk.port, 12345);
  assert.equal(onDisk.username, 'di-user');
  assert.equal(onDisk.password, 'di-pass');
  assert.equal('useStateTargeting' in onDisk, false);
  assert.equal((await get()).status, 200);
  const { dataimpulse } = await (await get()).json();
  assert.deepEqual(dataimpulse, { host: 'gw.dataimpulse.com', port: 12345, username: 'di-user', password: 'di-pass' });
});

test('DELETE rejects active tasks with a conflict response', async t => {
  const { origin, request, cookie, token } = await fixture(t, { workflow: async (_config, { signal }) => {
    await new Promise(resolveDone => signal.addEventListener('abort', resolveDone, { once: true }));
    return { status: 'cancelled' };
  } });
  const { job } = await (await request('/api/jobs', input())).json();
  const response = await fetch(`${origin}/api/jobs/${job.id}`, { method: 'DELETE', headers: { Cookie: cookie, 'X-Local-Token': token } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'JOB_ACTIVE');
});

test('ProgramId-only URLs are rejected and ?verificationId= URLs queue with distinct random task IDs', async t => {
  const gates = [];
  const { app, request } = await fixture(t, { workflow: async () => {
    const gate = Promise.withResolvers();
    gates.push(gate);
    await gate.promise;
    return { status: 'verified' };
  } });
  const programOnly = await request('/api/jobs', { url: 'https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?country=US&locale=en' });
  assert.equal(programOnly.status, 400);

  const first = await request('/api/jobs', { url });
  assert.equal(first.status, 202);
  const firstBody = await first.json();
  assert.notEqual(firstBody.job.id, 'bbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(firstBody.deduplicated, undefined);

  const second = await request('/api/jobs', { url });
  assert.equal(second.status, 202);
  const secondBody = await second.json();
  assert.notEqual(secondBody.job.id, firstBody.job.id);
  assert.notEqual(secondBody.job.id, 'bbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(secondBody.job.state, 'queued');
  assert.equal(secondBody.job.queuePosition, 1);
  assert.equal(secondBody.deduplicated, undefined);
  assert.equal(app.jobs.jobs.size, 2);

  while (gates.length < 2) {
    for (const g of gates) g.resolve();
    await new Promise(r => setTimeout(r, 10));
  }
  for (const g of gates) g.resolve();
  await Promise.all([
    app.jobs.jobs.get(firstBody.job.id).done,
    app.jobs.jobs.get(secondBody.job.id).done,
  ]);
});


test('Web persists NodeMaven and proxyProvider settings and switches provider per job', async t => {
  const receivedConfigs = [];
  const { origin, cookie, token, configFile, start, request } = await fixture(t, {
    workflow: async config => {
      receivedConfigs.push({ proxyProvider: config.proxyProvider, nodemaven: config.nodemaven, dataimpulse: config.dataimpulse, proxy: config.proxy });
      return { status: 'verified' };
    },
  });
  const headers = { Cookie: cookie, 'X-Local-Token': token, 'Content-Type': 'application/json' };

  // Launching with explicit unconfigured provider is rejected cleanly.
  const missingNm = await request('/api/jobs', input({ proxyProvider: 'nodemaven' }));
  assert.equal(missingNm.status, 400);

  const saved = await fetch(`${origin}/api/settings/proxy`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      proxyProvider: 'nodemaven',
      nodemaven: { host: 'gate.nodemaven.com', port: 8080, username: 'nm-u', password: 'nm-p', filter: 'medium-fast', ipv4Only: true },
      dataimpulse: { host: 'gw.dataimpulse.com', port: 10000, username: 'di-u', password: 'di-p' },
    }),
  });
  assert.equal(saved.status, 200);
  const { readFile } = await import('node:fs/promises');
  const disk = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(disk.proxyProvider, 'nodemaven');
  assert.equal(disk.nodemaven.username, 'nm-u');
  assert.equal(disk.nodemaven.filter, 'medium-fast');

  const getRes = await fetch(`${origin}/api/settings/proxy`, { headers: { Cookie: cookie } });
  assert.equal(getRes.status, 200);
  const loaded = await getRes.json();
  assert.equal(loaded.proxyProvider, 'nodemaven');
  assert.equal(loaded.nodemaven.username, 'nm-u');

  // Default uses nodemaven; job submission can override to dataimpulse or direct.
  const jobNm = await start(input());
  assert.equal(jobNm.job.proxyProvider, 'nodemaven');
  const jobDi = await start(input({ proxyProvider: 'dataimpulse' }));
  assert.equal(jobDi.job.proxyProvider, 'dataimpulse');
  const jobDirect = await start(input({ proxyProvider: 'direct' }));
  assert.equal(jobDirect.job.proxyProvider, 'direct');

  assert.equal(receivedConfigs[0].proxyProvider, 'nodemaven');
  assert.equal(receivedConfigs[1].proxyProvider, 'dataimpulse');
  assert.equal(receivedConfigs[2].proxyProvider, 'direct');
});
