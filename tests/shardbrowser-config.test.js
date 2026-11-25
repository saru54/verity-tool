import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../src/core/config.js';
import { DEFAULT_SHARDBROWSER_FILE, resolveShardBrowserSettings } from '../src/core/shardbrowser-config.js';

const raw = {
  app: 'sheerid',
  url: 'https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=bbbbbbbbbbbbbbbbbbbbbbbb',
};

async function tempFile(t, name, content) {
  const directory = await mkdtemp(join(tmpdir(), 'one-sb-config-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, name);
  if (content !== undefined) await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

test('The root shardbrowser.json supplies the launcher key by default', async t => {
  assert.ok(DEFAULT_SHARDBROWSER_FILE.endsWith('shardbrowser.json'));
  const file = await tempFile(t, 'sb.json', {
    endpoint: 'http://127.0.0.1:41000', token: 'root-file-token', platform: 'Windows', timeoutMs: 25000,
  });
  const settings = await resolveShardBrowserSettings({ shardBrowser: { configFile: file } }, {});
  assert.equal(settings.endpoint, 'http://127.0.0.1:41000');
  assert.equal(settings.token, 'root-file-token');
  assert.equal(settings.timeoutMs, 25000);
  assert.equal(settings.tokenSource, 'file');

  // The main config wins over the file, the environment only fills the gaps.
  const overridden = await resolveShardBrowserSettings(
    { shardBrowser: { configFile: file, token: 'config-token', endpoint: 'http://127.0.0.1:42000' } },
    { SHARDBROWSER_ENDPOINT: 'http://127.0.0.1:43000', SHARDBROWSER_TOKEN: 'env-token' },
  );
  assert.equal(overridden.token, 'config-token');
  assert.equal(overridden.endpoint, 'http://127.0.0.1:42000');
  assert.equal(overridden.tokenSource, 'config');

  const envOnly = await resolveShardBrowserSettings(
    { shardBrowser: { configFile: await tempFile(t, 'empty.json', {}) } },
    { SHARDBROWSER_TOKEN: 'env-token', SHARDBROWSER_ENDPOINT: 'http://127.0.0.1:43000' },
  );
  assert.equal(envOnly.token, 'env-token');
  assert.equal(envOnly.tokenSource, 'env');
  assert.equal(envOnly.endpoint, 'http://127.0.0.1:43000');
});

test('A missing default file is tolerated, an explicitly configured one must exist', async t => {
  const missing = await tempFile(t, 'absent.json');
  // Default path missing: settings stay empty instead of failing config loading.
  const defaults = await resolveShardBrowserSettings({}, {});
  assert.equal(typeof defaults.token, 'string');
  await assert.rejects(resolveShardBrowserSettings({ shardBrowser: { configFile: missing } }, {}),
    { code: 'INVALID_SHARDBROWSER_CONFIG' });
  const invalid = await tempFile(t, 'bad.json', '{"token": 1}');
  await assert.rejects(resolveShardBrowserSettings({ shardBrowser: { configFile: invalid } }, {}),
    { code: 'INVALID_SHARDBROWSER_CONFIG' });
  const unknownKey = await tempFile(t, 'unknown.json', { token: 'x', secret: 'y' });
  await assert.rejects(resolveShardBrowserSettings({ shardBrowser: { configFile: unknownKey } }, {}),
    /不支持的配置项/);
});

test('Main config keeps validating the resolved ShardBrowser block', async () => {
  const viaDefaultFile = await normalizeConfig(raw, {});
  assert.equal(viaDefaultFile.shardBrowser.platform, 'Windows');
  assert.equal(['config', 'file', 'env', 'none'].includes(viaDefaultFile.shardBrowser.tokenSource), true);
  await assert.rejects(normalizeConfig({ ...raw, browser: { platform: 'macOS' } }, {}), /平台固定为 Windows/);
  await assert.rejects(normalizeConfig({ ...raw, shardBrowser: { endpoint: 'ftp://x' } }, {}), /endpoint/);
  await assert.rejects(normalizeConfig({ ...raw, materials: { kind: 'transcript' } }, {}), /materials.kind/);
  await assert.rejects(normalizeConfig({ ...raw, browser: { engine: 'chrome' } }, {}), /browser.engine/);
  await assert.rejects(normalizeConfig({ ...raw, shardBrowser: { configFile: 42 } }, {}), /configFile/);
});
