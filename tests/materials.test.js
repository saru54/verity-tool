import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUniversities, MATERIAL_KINDS, buildMaterialFiles } from '../src/materials/index.js';
import { generateIdentity, currentSemester, germanDate, transliterate } from '../src/core/german-identity.js';
import { generateIdentity as generateUSIdentity, currentSemester as currentUSSemester, usDate, transliterate as transliterateUS } from '../src/core/us-identity.js';
import {
  listMaterials, materialDirectory, prepareMaterialsForConfig, readMaterial,
  readMaterialFile, recordMaterialAttempt, publicMaterial,
} from '../src/core/materials-store.js';
import { normalizeConfig } from '../src/core/config.js';
import { buildDataImpulseProxy, parseProxy } from '../src/core/proxy.js';

const PLACEHOLDER = /xxx+|example|placeholder|TODO|tbd|mustermann|musterfrau|John Doe|Jane Doe/i;

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'one-material-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

function baseConfig(directory, extra = {}) {
  return {
    app: 'sheerid', url: 'https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=bbbbbbbbbbbbbbbbbbbbbbbb',
    artifactsDir: directory, document: { path: '', url: '' }, data: {}, timeouts: { downloadMs: 1000, uploadMs: 1000 },
    materials: { enabled: true, reuse: true, kind: 'enrollment' }, ...extra,
  };
}

// Minimal structural PDF check: header, xref offsets, object headers, trailer.
function inspectPdf(buffer) {
  const text = buffer.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.7'), 'PDF header');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'PDF trailer');
  const startxref = Number(text.match(/startxref\s+(\d+)/)?.[1]);
  const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n /gm)].map(match => Number(match[1]));
  assert.ok(offsets.length >= 5, 'xref entries');
  offsets.forEach((offset, index) => {
    assert.match(text.slice(offset, offset + 12), new RegExp(`^${index + 1} 0 obj`));
  });
  assert.equal(Number(text.match(/\/Size (\d+)/)[1]), offsets.length + 1);
  return text;
}

// === US university dataset (primary) ===

test('US university dataset is real, complete and placeholder-free', async () => {
  const universities = await loadUniversities('us');
  assert.ok(universities.length >= 10, `expected at least 10 US universities, got ${universities.length}`);
  assert.equal(new Set(universities.map(entry => entry.id)).size, universities.length, 'unique ids');
  assert.equal(new Set(universities.map(entry => entry.emailDomain)).size, universities.length, 'unique mail domains');
  for (const entry of universities) {
    assert.match(entry.name, /[A-Z]/, `${entry.id} name`);
    assert.ok(PLACEHOLDER.test(JSON.stringify(entry)) === false, `${entry.id} contains a placeholder`);
    assert.equal(entry.country, 'United States');
    assert.match(entry.city, /^[A-Z][\w\s.'()-]+$/, `${entry.id} city`);
    assert.match(entry.state, /^[A-Z][a-z]+(\s[A-Z][a-z]+)*$/, `${entry.id} state`);
    assert.match(entry.stateCode, /^[a-z]{2}$/i, `${entry.id} stateCode`);
    assert.match(entry.street, /^.{4,}$/, `${entry.id} street`);
    assert.match(entry.postalCode, /^\d{5}$/, `${entry.id} postal code`);
    assert.match(entry.emailDomain, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${entry.id} mail domain`);
    assert.match(entry.website, /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/, `${entry.id} website`);
    assert.match(entry.phone, /^\+1[\d\s-]+$/, `${entry.id} phone`);
    assert.ok(entry.registrar.length > 8, `${entry.id} registrar`);
    assert.ok(entry.programs.length >= 4, `${entry.id} programs`);
    assert.ok(entry.programs.every(program => /(B\.|M\.|A\.|Ph\.D\.|B\.B\.A\.|M\.C\.S\.|M\.Eng\.|M\.S\.)/.test(program)), `${entry.id} program names`);
    assert.ok(entry.matriculationDigits >= 7 && entry.matriculationDigits <= 9, `${entry.id} Student ID length`);
  }
});

test('Generated US identities are plausible, deterministic and placeholder-free', async () => {
  const universities = await loadUniversities('us');
  const seed = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const identity = generateUSIdentity(seed, universities[0], { now: new Date('2026-11-17T00:00:00Z') });
  assert.equal(identity.university.id, universities[0].id);
  assert.match(identity.firstName, /^[A-Z][a-z]+$/);
  assert.match(identity.lastName, /^[A-Z][a-z]+$/);
  assert.ok(PLACEHOLDER.test(JSON.stringify(identity)) === false);
  const age = 2026 - Number(identity.birthDate.slice(0, 4));
  assert.ok(age >= 18 && age <= 28, `age ${age}`);
  assert.match(identity.birthDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(identity.studentNumber, /^\w+$/);
  assert.equal(identity.email, `${transliterateUS(identity.firstName).toLowerCase()}.${transliterateUS(identity.lastName).toLowerCase()}@${universities[0].emailDomain}`);
  assert.deepEqual(identity.semester, currentUSSemester(new Date('2026-11-17T00:00:00Z')));
  assert.match(identity.semester.label, /^Fall 2026$/);
  assert.ok(['Freshman', 'Sophomore', 'Junior', 'Senior'].includes(identity.academicYearLabel));
  // Deterministic per verificationId, different across tasks.
  assert.deepEqual(generateUSIdentity(seed, universities[0], { now: new Date('2026-11-17T00:00:00Z') }), identity);
  const other = generateUSIdentity('cccccccccccccccccccccccc', universities[1], { now: new Date('2026-11-17T00:00:00Z') });
  assert.notEqual(`${other.firstName}.${other.lastName}`, `${identity.firstName}.${identity.lastName}`);
});

test('US enrollment certificate and term verification are valid PDFs carrying the identity', async () => {
  const universities = await loadUniversities('us');
  const identity = generateUSIdentity('bbbbbbbbbbbbbbbbbbbbbbbb', universities[0], { now: new Date('2026-11-17T00:00:00Z') });
  const registrar = (await import('../src/materials/us-enrollment.js')).generateRegistrar('bbbbbbbbbbbbbbbbbbbbbbbb');
  const full = { ...identity, registrar, issueDate: '2026-11-17' };
  const files = buildMaterialFiles(full);
  assert.deepEqual(files.map(file => file.name), Object.values(MATERIAL_KINDS));
  for (const file of files) {
    assert.equal(file.mimeType, 'application/pdf');
    assert.ok(file.bytes.length > 2000 && file.bytes.length < 20 * 1024 * 1024, `${file.name} size`);
    const text = inspectPdf(file.bytes);
    for (const needle of [full.lastName, full.firstName, full.studentNumber, full.program]) {
      assert.ok(text.includes(needle), `${file.name} contains ${needle}`);
    }
    if (file.name === MATERIAL_KINDS.enrollment) {
      assert.ok(text.includes(usDate(full.birthDate)), 'certificate carries the birth date');
      assert.ok(text.includes(full.enrolledSince), 'certificate carries the enrollment term');
      assert.ok(text.includes('Certificate of Enrollment'));
      assert.ok(text.includes('Student ID'));
    }
    assert.ok(!/\(xxx\)|placeholder/i.test(text), `${file.name} has no placeholder text`);
  }
});

// === German university dataset (backward compatibility) ===

test('German university dataset is real, complete and placeholder-free', async () => {
  const universities = await loadUniversities('de');
  assert.ok(universities.length >= 35, `expected at least 35 German universities, got ${universities.length}`);
  assert.equal(new Set(universities.map(entry => entry.id)).size, universities.length, 'unique ids');
  assert.equal(new Set(universities.map(entry => entry.emailDomain)).size, universities.length, 'unique mail domains');
  for (const entry of universities) {
    assert.ok(PLACEHOLDER.test(JSON.stringify(entry)) === false, `${entry.id} contains a placeholder`);
    assert.equal(entry.country, 'Germany');
    assert.match(entry.phone, /^\+49[\d\s]+$/, `${entry.id} phone`);
    assert.ok(entry.secretariat.length > 8, `${entry.id} secretariat`);
    assert.match(entry.semesterFee, /^\d+,\d{2}$/, `${entry.id} semester fee`);
  }
});

test('Generated German identities are plausible, deterministic and placeholder-free', async () => {
  const universities = await loadUniversities('de');
  const seed = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const identity = generateIdentity(seed, universities[0], { now: new Date('2026-11-17T00:00:00Z') });
  assert.equal(identity.university.id, universities[0].id);
  assert.match(identity.firstName, /^[A-ZÄÖÜ][a-zäöüß]+$/);
  assert.match(identity.lastName, /^[A-ZÄÖÜ][a-zäöüß]+$/);
  assert.ok(PLACEHOLDER.test(JSON.stringify(identity)) === false);
  const age = 2026 - Number(identity.birthDate.slice(0, 4));
  assert.ok(age >= 18 && age <= 28, `age ${age}`);
  assert.match(identity.birthDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(identity.studentNumber.length, universities[0].matriculationDigits);
  assert.match(identity.studentNumber, /^\d+$/);
  assert.equal(identity.email, `${transliterate(identity.firstName).toLowerCase()}.${transliterate(identity.lastName).toLowerCase()}@${universities[0].emailDomain}`);
  assert.deepEqual(identity.semester, currentSemester(new Date('2026-11-17T00:00:00Z')));
  assert.match(identity.semester.label, /^Wintersemester 2026\/27$/);
  assert.deepEqual(generateIdentity(seed, universities[0], { now: new Date('2026-11-17T00:00:00Z') }), identity);
  const other = generateIdentity('cccccccccccccccccccccccc', universities[1], { now: new Date('2026-11-17T00:00:00Z') });
  assert.notEqual(`${other.firstName}.${other.lastName}`, `${identity.firstName}.${identity.lastName}`);
});

test('Materials are always generated fresh per run and archived for inspection', async t => {
  const directory = await tempDir(t);
  const config = baseConfig(directory);
  const verificationId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const first = await prepareMaterialsForConfig(config, { verificationId });
  assert.equal(first.source, 'generated');
  assert.ok(first.documentPath.endsWith('enrollment-certificate.pdf'));
  assert.equal(config.document.path, first.documentPath);
  assert.equal(config.data.firstName, first.identity.firstName);
  assert.equal(config.data.country, 'United States');
  const directoryFiles = await readdir(materialDirectory(directory, verificationId));
  assert.deepEqual(directoryFiles.sort(),
    ['enrollment-certificate.pdf', 'material.json', 'term-verification.pdf']);

  const archived = await readMaterial(directory, verificationId);
  assert.equal(archived.url, config.url);
  assert.equal(archived.summary.identity.studentNumber, first.identity.studentNumber);

  // Re-running without an explicit seed always generates fresh materials (no reuse).
  const second = await prepareMaterialsForConfig(baseConfig(directory), { verificationId });
  assert.equal(second.source, 'generated');
  assert.notEqual(second.identity.studentNumber, first.identity.studentNumber);

  // Different tasks sharing a sheeridVerificationId get separate archive folders and
  // the latest archive can be cloned into a new taskId folder when continuing docUpload.
  const { findLatestMaterialByVerificationId, prepareArchivedMaterialsForConfig } = await import('../src/core/materials-store.js');
  const taskConfigA = baseConfig(directory);
  const runA = await prepareMaterialsForConfig(taskConfigA, {
    verificationId: 'cccccccccccccccccccccccc',
    task: { taskId: 'cccccccccccccccccccccccc', sheeridVerificationId: '111111111111111111111111' },
  });
  const latest = await findLatestMaterialByVerificationId(directory, '111111111111111111111111');
  assert.equal(latest.archiveId, 'cccccccccccccccccccccccc');
  const cloned = await prepareArchivedMaterialsForConfig(baseConfig(directory), {
    verificationId: 'eeeeeeeeeeeeeeeeeeeeeeee',
    sourceVerificationId: latest.archiveId,
    task: { taskId: 'eeeeeeeeeeeeeeeeeeeeeeee', sheeridVerificationId: '111111111111111111111111' },
  });
  assert.notEqual(cloned.documentPath, runA.documentPath);
  assert.equal(cloned.identity.studentNumber, runA.identity.studentNumber);
  assert.equal(cloned.source, 'archived');

  await recordMaterialAttempt(directory, verificationId, { runId: 'run-1', status: 'verified', code: 'STEP_RECEIVED', stage: 'wait_review', uploadAttempt: 1, document: 'enrollment-certificate.pdf' });
  const withAttempts = publicMaterial(verificationId, await readMaterial(directory, verificationId));
  assert.equal(withAttempts.attempts.length, 1);
  assert.equal(withAttempts.lastStatus, 'verified');
  assert.equal(withAttempts.attempts[0].document, 'enrollment-certificate.pdf');
  assert.equal(withAttempts.url, config.url);

  const listed = await listMaterials(directory);
  assert.equal(listed.length, 3);
  assert.ok(listed.some(item => item.verificationId === verificationId));

  const { entry, bytes } = await readMaterialFile(directory, verificationId, 'term-verification.pdf');
  assert.equal(entry.mimeType, 'application/pdf');
  assert.ok(bytes.length > 1000);

  // Tampering with an archived file must be detected by the stored digest.
  const target = join(materialDirectory(directory, verificationId), 'term-verification.pdf');
  const original = await readFile(target);
  await writeFile(target, Buffer.concat([original, Buffer.from('\n%tampered\n')]));
  await assert.rejects(readMaterialFile(directory, verificationId, 'term-verification.pdf'), { code: 'MATERIAL_FILE_CORRUPT' });
  await assert.rejects(readMaterialFile(directory, verificationId, '../material.json'), { code: 'MATERIAL_FILE_NOT_FOUND' });
  assert.throws(() => materialDirectory(directory, 'not-an-id'), { code: 'INVALID_CONFIG' });
});

// === DataImpulse dynamic proxy ===

test('DataImpulse proxy builder targets country and session without state targeting', () => {
  const di = { host: 'gw.dataimpulse.com', port: 10000, username: 'testuser', password: 'testpass' };
  const proxy = buildDataImpulseProxy(di, { countryCode: 'US', sessionId: 'sess123' });
  assert.equal(proxy.server, 'http://gw.dataimpulse.com:10000');
  assert.equal(proxy.username, 'testuser__cr.us;sessid.sess123');
  assert.equal(proxy.password, 'testpass');

  // Legacy stateCode option is ignored; only country and session are concatenated.
  const proxyNoState = buildDataImpulseProxy(di, { countryCode: 'us', stateCode: 'New York' });
  assert.equal(proxyNoState.username, 'testuser__cr.us');

  const proxy2 = buildDataImpulseProxy(di, { countryCode: 'de' });
  assert.equal(proxy2.username, 'testuser__cr.de');

  // Parsed proxy should round-trip
  const parsed = parseProxy(proxy);
  assert.equal(parsed.server, 'http://gw.dataimpulse.com:10000');
  assert.equal(parsed.username, 'testuser__cr.us;sessid.sess123');
});

test('DataImpulse proxy is auto-configured from university country in prepareMaterialsForConfig', async t => {
  const directory = await tempDir(t);
  const di = { host: 'gw.dataimpulse.com', port: 10000, username: 'mylogin', password: 'mypass' };
  const config = baseConfig(directory, { dataimpulse: di, proxy: null });
  await prepareMaterialsForConfig(config, { verificationId: 'bbbbbbbbbbbbbbbbbbbbbbbb' });
  assert.ok(config.proxy, 'proxy should be set after prepareMaterialsForConfig');
  assert.match(config.proxy.username, /__cr\.us/, 'proxy targets US');
  assert.match(config.proxy.username, /;sessid\./, 'proxy has a session ID');
  assert.doesNotMatch(config.proxy.username, /;state\./, 'state targeting is never concatenated');
  assert.equal(config.proxy.server, 'http://gw.dataimpulse.com:10000');

  // Legacy useStateTargeting in config is tolerated without breaking or adding ;state.
  const legacy = baseConfig(directory, { dataimpulse: { ...di, useStateTargeting: true }, proxy: null });
  await prepareMaterialsForConfig(legacy, { verificationId: 'bbbbbbbbbbbbbbbbbbbbbbbb' });
  assert.doesNotMatch(legacy.proxy.username, /;state\./, 'legacy useStateTargeting does not add state targeting');
});

test('ShardBrowser-specific configuration is validated and defaults are safe', async t => {
  const raw = {
    app: 'sheerid', url: 'https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=bbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const config = await normalizeConfig(raw, {});
  assert.equal(config.browser.engine, 'camoufox');
  assert.equal(config.shardBrowser.platform, 'Windows');
  assert.equal(config.shardBrowser.endpoint, 'http://127.0.0.1:40325');
  assert.equal(config.materials.enabled, true);
  assert.equal(config.materials.reuse, false);
  assert.equal(config.materials.kind, 'enrollment');
  // Keep this case independent from the local root credential file.
  const directory = await tempDir(t);
  const emptyFile = join(directory, 'empty.json');
  await writeFile(emptyFile, '{}');
  const fromEnv = await normalizeConfig(
    { ...raw, shardBrowser: { configFile: emptyFile } },
    { SHARDBROWSER_TOKEN: 'env-token', SHARDBROWSER_ENDPOINT: 'http://127.0.0.1:9999' },
  );
  assert.equal(fromEnv.shardBrowser.token, 'env-token');
  assert.equal(fromEnv.shardBrowser.tokenSource, 'env');
  assert.equal(fromEnv.shardBrowser.endpoint, 'http://127.0.0.1:9999');
  await assert.rejects(normalizeConfig({ ...raw, browser: { platform: 'macOS' } }, {}), /平台固定为 Windows/);
  await assert.rejects(normalizeConfig({ ...raw, shardBrowser: { endpoint: 'ftp://x' } }, {}), /endpoint/);
  await assert.rejects(normalizeConfig({ ...raw, materials: { kind: 'transcript' } }, {}), /materials.kind/);
  await assert.rejects(normalizeConfig({ ...raw, browser: { engine: 'chrome' } }, {}), /browser.engine/);
});


test('Generated US and DE PDFs use realistic producers and avoid mojibake or fraud-bait text', async () => {
  const { buildIdentityBundle, buildMaterialFiles, loadUniversities } = await import('../src/materials/index.js');
  for (const [seed, country] of [['fraud-check-us-1', 'us'], ['fraud-check-de-1', 'de']]) {
    const universities = await loadUniversities(country);
    const identity = buildIdentityBundle({ seed, university: universities[0] });
    const files = buildMaterialFiles(identity);
    assert.equal(files.length, 2);
    assert.notEqual(Buffer.compare(files[0].bytes, files[1].bytes), 0);

    for (const [index, file] of files.entries()) {
      const text = file.bytes.toString('latin1');
      assert.equal(text.includes('sheeridVerify'), false, `${country} file ${file.name} leaked synthetic producer`);
      assert.equal(text.includes('eligible for student benefits'), false, `${country} file ${file.name} kept fraud-bait copy`);
      assert.match(text, /\/Producer \(([^)]+)\)/);
      assert.match(text, /\/Creator \(([^)]+)\)/);
      assert.equal(/\([^)\r\n]*\?[^)\r\n]*\)\s*Tj/.test(text), false, `${country} file ${file.name} contains WinAnsi ? placeholder`);
      assert.equal(/\?\s*(Confirmed|Active|Bezahlt|Enrolled|Full-time)/i.test(text), false,
        `${country} file ${file.name} contains corrupted checkmark`);
      if (index === 1) {
        assert.match(text, /\/Producer \(Skia\/PDF/);
      }
    }
  }
});


test('NodeMaven proxy builder formats official username flags and defaults over DataImpulse', async t => {
  const {
    buildNodeMavenProxy, normalizeNodeMavenConfig, resolveDynamicProvider,
  } = await import('../src/core/proxy.js');
  const nm = normalizeNodeMavenConfig({ username: 'nmuser', password: 'nmpass' });
  assert.equal(nm.host, 'gate.nodemaven.com');
  assert.equal(nm.port, 8080);
  assert.equal(nm.filter, 'medium');
  assert.equal(nm.ipv4Only, true);

  const built = buildNodeMavenProxy(nm, { countryCode: 'GB', sessionId: 'abc-123def456' });
  assert.equal(built.server, 'http://gate.nodemaven.com:8080');
  assert.equal(built.username, 'nmuser-country-gb-ipv4-true-sid-abc123def456-filter-medium');
  assert.equal(built.password, 'nmpass');

  const socks = buildNodeMavenProxy({ ...nm, port: 1080, filter: 'medium-fast', ipv4Only: false }, { countryCode: 'de', sessionId: 's1' });
  assert.equal(socks.server, 'socks5://gate.nodemaven.com:1080');
  assert.equal(socks.username, 'nmuser-country-de-sid-s1-filter-medium-speed-fast');

  assert.throws(() => normalizeNodeMavenConfig({ username: 'u', password: 'p', filter: 'invalid' }), { code: 'INVALID_CONFIG' });

  const di = { host: 'gw.dataimpulse.com', port: 10000, username: 'diuser', password: 'dipass' };
  assert.equal(resolveDynamicProvider({ nodemaven: nm, dataimpulse: di })?.name, 'nodemaven');
  assert.equal(resolveDynamicProvider({ proxyProvider: 'dataimpulse', nodemaven: nm, dataimpulse: di })?.name, 'dataimpulse');
  assert.equal(resolveDynamicProvider({ proxyProvider: 'direct', nodemaven: nm, dataimpulse: di }), null);

  const directory = await tempDir(t);
  const cfg = baseConfig(directory, { nodemaven: nm, dataimpulse: di, proxy: null });
  await prepareMaterialsForConfig(cfg, { verificationId: 'bbbbbbbbbbbbbbbbbbbbbbbb' });
  assert.equal(cfg.proxy.server, 'http://gate.nodemaven.com:8080');
  assert.match(cfg.proxy.username, /^nmuser-country-us-ipv4-true-sid-/);
});
