import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { WebJobs } from '../src/web/jobs.js';
import { normalizeConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { webConfig } from './fixtures/web-config.js';

const id = number => number.toString(16).padStart(24, '0');
const input = number => ({ url: `https://my.sheerid.com/rest/v2/verification/${id(number)}`,
  firstName: 'Queue', lastName: 'Fixture', birthDate: '2000-01-02' });

async function fixture(t, concurrency) {
  const { configFile, raw } = await webConfig(t);
  if (concurrency !== undefined) raw.web = { concurrency };
  await writeFile(configFile, JSON.stringify(raw));
  const started = [], controls = new Map();
  let active = 0, peak = 0;
  const jobs = new WebJobs({ configFile, workflow: async (config, { signal }) => {
    const taskId = config.url.split('/').at(-1);
    started.push(taskId);
    peak = Math.max(peak, ++active);
    const gate = Promise.withResolvers();
    const control = { finish: gate.resolve, fail: gate.reject, aborted: false };
    controls.set(taskId, control);
    signal.addEventListener('abort', () => { control.aborted = true; }, { once: true });
    try { await gate.promise; return { status: 'pending' }; }
    finally { active--; }
  } });
  await jobs.initialize();
  t.after(async () => {
    const closing = jobs.close();
    await jobs.admissions;
    for (const control of controls.values()) control.finish();
    await closing;
  });
  return { jobs, started, controls, configFile, raw, peak: () => peak };
}

test('Configured concurrency runs N jobs and starts the remaining jobs in FIFO order', async t => {
  const { jobs, controls, started, peak } = await fixture(t, 2);
  const snapshots = await Promise.all([1, 2, 3, 4, 5].map(n => jobs.start(input(n))));
  const jid = snapshots.map(job => job.id);
  assert.equal(new Set(jid).size, 5);
  assert.deepEqual(started, [id(1), id(2)]);
  assert.deepEqual(snapshots.map(job => job.state), ['running', 'running', 'queued', 'queued', 'queued']);
  assert.deepEqual(jobs.list().jobs.map(job => job.queuePosition), [null, null, 1, 2, 3]);
  controls.get(id(1)).finish();
  await jobs.jobs.get(jid[0]).done;
  assert.deepEqual(started, [id(1), id(2), id(3)]);
  controls.get(id(2)).fail(new Error('fixture failure'));
  await jobs.jobs.get(jid[1]).done;
  assert.equal(jobs.get(jid[1]).job.state, 'failed');
  assert.deepEqual(started, [id(1), id(2), id(3), id(4)]);
  assert.equal(jobs.get(jid[4]).job.queuePosition, 1);
  assert.equal(peak(), 2);
});

test('Stopped queued jobs resume at the tail once, retaining identity and original settings', async t => {
  const { jobs, started, controls, peak } = await fixture(t);
  const [j1, j2, j3] = (await Promise.all([1, 2, 3].map(n => jobs.start(input(n))))).map(j => j.id);
  const config = jobs.jobs.get(j2).config;
  jobs.jobs.get(j2).resumeUncertainStage = 'upload_bytes';
  jobs.cancel(j2);
  assert.equal(jobs.get(j2).job.result.uncertainStage, 'upload_bytes');
  const oldDone = jobs.jobs.get(j2).done;
  const sequence = jobs.get(j2).job.lastSequence;
  assert.equal(jobs.resume(j2).queuePosition, 2);
  assert.equal(jobs.resume(j2).queuePosition, 2);
  assert.equal(jobs.jobs.get(j2).config, config);
  assert.equal(jobs.jobs.get(j2).resumeUncertainStage, 'upload_bytes');
  assert.notEqual(jobs.jobs.get(j2).done, oldDone);
  assert.equal(jobs.jobs.get(j2).controller.signal.aborted, false);
  assert.equal(jobs.jobs.size, 3);
  assert.equal(jobs.get(j2, sequence).events.length, 1);
  controls.get(id(1)).finish();
  await jobs.jobs.get(j1).done;
  assert.deepEqual(started, [id(1), id(3)]);
  controls.get(id(3)).finish();
  await jobs.jobs.get(j3).done;
  assert.deepEqual(started, [id(1), id(3), id(2)]);
  jobs.resume(j2);
  assert.equal(started.length, 3);
  controls.get(id(2)).finish();
  await jobs.jobs.get(j2).done;
  assert.equal(peak(), 1);
  assert.throws(() => jobs.resume(j2), { code: 'JOB_NOT_RESUMABLE' });
  assert.throws(() => jobs.resume(id(99)), { code: 'JOB_NOT_FOUND' });
});

test('Running jobs only resume after cleanup, and shutdown prohibits resuming', async t => {
  const { jobs, controls, started } = await fixture(t);
  const { id: j1 } = await jobs.start(input(1));
  jobs.cancel(j1);
  assert.throws(() => jobs.resume(j1), { code: 'JOB_NOT_RESUMABLE' });
  controls.get(id(1)).finish();
  await jobs.jobs.get(j1).done;
  jobs.resume(j1);
  assert.deepEqual(started, [id(1), id(1)]);
  assert.equal(controls.get(id(1)).aborted, false);
  const closing = jobs.close();
  assert.throws(() => jobs.resume(j1), { code: 'SERVER_STOPPING' });
  await jobs.admissions;
  controls.get(id(1)).finish();
  await closing;
});

test('Shutdown cancels running and waiting jobs without starting the queue', async t => {
  const { jobs, started, controls } = await fixture(t, 2);
  const [, , j3, j4] = (await Promise.all([1, 2, 3, 4].map(n => jobs.start(input(n))))).map(j => j.id);
  const closing = jobs.close();
  await jobs.admissions;
  await Promise.resolve();
  assert.equal(jobs.get(j3).job.state, 'cancelled');
  assert.equal(jobs.get(j4).job.state, 'cancelled');
  for (const control of controls.values()) { assert.equal(control.aborted, true); control.finish(); }
  await closing;
  assert.deepEqual(started, [id(1), id(2)]);
  assert.equal(jobs.running.size, 0);
  await assert.rejects(jobs.start(input(5)), { code: 'SERVER_STOPPING' });
});

test('Changed concurrency applies on next admission; invalid settings do not admit jobs', async t => {
  const { jobs, configFile, raw, started } = await fixture(t);
  await jobs.start(input(1));
  await jobs.start(input(2));
  raw.web = { concurrency: 2 };
  await writeFile(configFile, JSON.stringify(raw));
  await jobs.start(input(3));
  assert.deepEqual(started, [id(1), id(2)]);
  for (const concurrency of [0, -1, 1.5, '2']) {
    raw.web.concurrency = concurrency;
    await writeFile(configFile, JSON.stringify(raw));
    await assert.rejects(jobs.start(input(4)), { code: 'INVALID_CONFIG' });
    assert.equal(jobs.jobs.size, 3);
    await assert.rejects(normalizeConfig({ ...raw, proxy: 'direct' }, {}), { code: 'INVALID_CONFIG' });
  }
});

test('Concurrent asynchronous workflow logs remain attached to their own task IDs', async t => {
  const { configFile, raw } = await webConfig(t);
  raw.web = { concurrency: 2 };
  await writeFile(configFile, JSON.stringify(raw));
  const gates = new Map();
  const jobs = new WebJobs({ configFile, workflow: async config => {
    const targetId = config.url.split('/').at(-1);
    const log = createLogger(targetId);
    const gate = Promise.withResolvers();
    gates.set(targetId, gate);
    log('stage_started', { stage: 'fill' });
    await gate.promise;
    log('run_finished', { status: 'pending' });
    return { status: 'pending' };
  } });
  t.after(async () => { for (const gate of gates.values()) gate.resolve(); await jobs.close(); });
  const [j1, j2] = (await Promise.all([1, 2].map(n => jobs.start(input(n))))).map(j => j.id);
  gates.get(id(2)).resolve();
  await jobs.jobs.get(j2).done;
  gates.get(id(1)).resolve();
  await jobs.jobs.get(j1).done;
  for (const [index, jid] of [[1, j1], [2, j2]]) {
    const records = jobs.get(jid).events.filter(event => event.runId);
    assert.equal(records.length, 2);
    assert.ok(records.every(event => event.runId === id(index)));
  }
});

test('Deletion preserves active slots and queued work until explicitly stopped', async t => {
  const { jobs, controls, started } = await fixture(t);
  const [j1, j2, j3] = (await Promise.all([1, 2, 3].map(n => jobs.start(input(n))))).map(j => j.id);
  for (const jid of [j1, j2]) assert.throws(() => jobs.remove(jid), { code: 'JOB_ACTIVE' });
  jobs.cancel(j1);
  assert.throws(() => jobs.remove(j1), { code: 'JOB_ACTIVE' });
  assert.equal(jobs.running.size, 1);
  jobs.cancel(j2);
  jobs.remove(j2);
  assert.throws(() => jobs.get(j2), { code: 'JOB_NOT_FOUND' });
  assert.throws(() => jobs.resume(j2), { code: 'JOB_NOT_FOUND' });
  controls.get(id(1)).finish();
  await jobs.jobs.get(j1).done;
  jobs.remove(j1);
  assert.deepEqual(started, [id(1), id(3)]);
  assert.equal(jobs.running.size, 1);
  controls.get(id(3)).fail(new Error('fixture failure'));
  await jobs.jobs.get(j3).done;
  assert.equal(jobs.get(j3).job.state, 'failed');
  jobs.remove(j3);
  assert.equal(jobs.list().jobs.length, 0);
  await jobs.close();
  assert.throws(() => jobs.remove(j3), { code: 'SERVER_STOPPING' });
});
