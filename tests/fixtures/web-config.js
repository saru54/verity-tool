import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function webConfig(t) {
  const directory = await mkdtemp(join(tmpdir(), 'one-web-config-'));
  const configFile = join(directory, 'settings.json');
  const raw = {
    app: 'sheerid', url: 'https://my.sheerid.com/rest/v2/verification/cccccccccccccccccccccccc',
    proxy: 'http://saved-user:saved-secret@127.0.0.1:7777',
    data: { firstName: 'Saved', lastName: 'Person', birthDate: '1999-01-01', email: 'saved@example.edu',
      country: 'United States', organization: { name: 'Example University', optionText: 'Example University', emailDomain: 'example.edu' }, consent: true },
    browser: { headless: true, keepOpen: false, autoFill: true, locale: 'zh-CN' },
    document: { path: '', url: 'http://localhost:3000/proof.png?page=2' },
    timeouts: { readyMs: 180000 }, interaction: { keyDelayMs: { min: 50, max: 100 } },
    selectors: { email: ['#email'] },
    // Isolated material archive per test: archived material is reused by design,
    // so a shared directory would leak identities between test cases.
    artifactsDir: join(directory, 'runs'),
  };
  await writeFile(configFile, JSON.stringify(raw));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return { configFile, raw };
}
