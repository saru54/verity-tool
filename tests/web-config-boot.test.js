import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWebConfigFile } from '../src/core/web-config-file.js';
import { WebJobs } from '../src/web/jobs.js';

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'one-web-config-boot-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

const example = JSON.stringify({ web: { concurrency: 3 }, app: 'sheerid', artifactsDir: 'runs' });

test('A missing local config is generated from the example on first start', async t => {
  const directory = await tempDir(t);
  const configFile = join(directory, 'config', 'sheerid.local.json');
  const exampleFile = join(directory, 'sheerid.example.json');
  await writeFile(exampleFile, example);

  const result = await ensureWebConfigFile(configFile, { exampleFile });
  assert.equal(result.created, true);
  assert.equal(result.configFile, configFile);
  assert.equal(result.raw.web.concurrency, 3);
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).app, 'sheerid');

  // A second start reads the existing file and does not overwrite it.
  await writeFile(configFile, JSON.stringify({ web: { concurrency: 7 }, app: 'sheerid' }));
  const reused = await ensureWebConfigFile(configFile, { exampleFile });
  assert.equal(reused.created, false);
  assert.equal(reused.raw.web.concurrency, 7);
});

test('Broken config is reported precisely and never overwritten', async t => {
  const directory = await tempDir(t);
  const configFile = join(directory, 'broken.json');
  await writeFile(configFile, '{ "web": { "concurrency": 2 }, }');
  await assert.rejects(ensureWebConfigFile(configFile, { exampleFile: join(directory, 'none.json') }),
    { code: 'INVALID_CONFIG' });
  assert.equal(await readFile(configFile, 'utf8'), '{ "web": { "concurrency": 2 }, }');

  await assert.rejects(ensureWebConfigFile(join(directory, 'missing.json'), { exampleFile: join(directory, 'none.json') }),
    { code: 'CONFIG_MISSING' });
});

test('WebJobs boots from the generated config and exposes its queue settings', async t => {
  const directory = await tempDir(t);
  const configFile = join(directory, 'config', 'sheerid.local.json');
  const exampleFile = join(directory, 'sheerid.example.json');
  await writeFile(exampleFile, JSON.stringify({ web: { concurrency: 2 }, app: 'sheerid', artifactsDir: join(directory, 'runs') }));

  const jobs = new WebJobs({ configFile, exampleFile, workflow: async () => ({ status: 'pending' }) });
  await jobs.initialize();
  t.after(() => jobs.close());
  assert.equal(jobs.configCreated, true);
  assert.equal(jobs.concurrency, 2);
  assert.equal(jobs.artifactsDir, join(directory, 'runs'));
  assert.deepEqual((await jobs.listMaterials()).materials, []);
});
