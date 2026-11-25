import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadUniversities, buildMaterialFiles, buildIdentityBundle, MATERIAL_KINDS, materialSummary } from '../src/materials/index.js';
import { generateIdentity as generateCAIdentity, caDate, generateRegistrar as generateCARegistrar, transliterate as transliterateCA } from '../src/core/ca-identity.js';
import { generateIdentity as generateUKIdentity, ukDate, generateRegistrar as generateUKRegistrar, transliterate as transliterateUK } from '../src/core/uk-identity.js';

const PLACEHOLDER = /xxx+|example|placeholder|TODO|tbd|mustermann|musterfrau|John Doe|Jane Doe/i;
const NOW = new Date('2026-11-17T00:00:00Z');

test('CA university dataset, identity generation, dispatch and PDFs are valid', async () => {
  const universities = await loadUniversities('ca');
  assert.ok(universities.length >= 10, `expected >= 10 CA universities, got ${universities.length}`);
  assert.equal(new Set(universities.map(entry => entry.id)).size, universities.length, 'unique ids');
  for (const entry of universities) {
    assert.match(entry.name, /[A-Z]/, `${entry.id} name`);
    assert.ok(PLACEHOLDER.test(JSON.stringify(entry)) === false, `${entry.id} placeholder`);
    assert.equal(entry.country, 'Canada');
    assert.equal(entry.countryCode, 'CA');
    assert.match(entry.postalCode, /^[A-Z]\d[A-Z] \d[A-Z]\d$/, `${entry.id} postal code`);
    assert.match(entry.emailDomain, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${entry.id} mail domain`);
    assert.ok(entry.programs.length >= 4, `${entry.id} programs`);
  }

  const seed = 'cccccccccccccccccccccccc';
  const identity = generateCAIdentity(seed, universities[0], { now: NOW });
  assert.equal(identity.university.countryCode, 'CA');
  assert.equal(identity.email, `${transliterateCA(identity.firstName).toLowerCase()}.${transliterateCA(identity.lastName).toLowerCase()}@${universities[0].emailDomain}`);
  assert.equal(caDate('2026-03-17'), '17/03/2026', 'DD/MM/YYYY');
  assert.deepEqual(generateCAIdentity(seed, universities[0], { now: NOW }), identity);

  const registrar = generateCARegistrar(seed);
  assert.ok(['University Registrar', 'Associate Registrar', 'Assistant Registrar', 'Deputy Registrar'].includes(registrar.role));

  const bundle = buildIdentityBundle({ seed, university: universities[0], now: NOW });
  assert.equal(bundle.university.countryCode, 'CA');
  const files = buildMaterialFiles({ ...identity, issueDate: '2026-11-17', registrar });
  assert.deepEqual(files.map(file => file.name), Object.values(MATERIAL_KINDS));
  assert.equal(materialSummary(bundle, files).university.country, 'Canada');

  for (const file of files) {
    assert.equal(file.mimeType, 'application/pdf');
    assert.ok(file.bytes.length > 2000 && file.bytes.length < 20 * 1024 * 1024, `${file.name} size`);
    const text = file.bytes.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.7'), 'PDF header');
    for (const needle of [identity.lastName, identity.studentNumber, identity.program]) {
      assert.ok(text.includes(needle), `${file.name} contains ${needle}`);
    }
    assert.ok(!/\(xxx\)|placeholder/i.test(text), `${file.name} has no placeholder text`);
  }
  assert.ok(files[0].bytes.toString('latin1').includes(caDate(identity.birthDate)), 'certificate carries DD/MM/YYYY birth date');
});

test('GB university dataset, identity generation, dispatch and PDFs are valid', async () => {
  const universities = await loadUniversities('gb');
  assert.ok(universities.length >= 10, `expected >= 10 GB universities, got ${universities.length}`);
  assert.equal(new Set(universities.map(entry => entry.id)).size, universities.length, 'unique ids');
  for (const entry of universities) {
    assert.match(entry.name, /[A-Z]/, `${entry.id} name`);
    assert.ok(PLACEHOLDER.test(JSON.stringify(entry)) === false, `${entry.id} placeholder`);
    assert.equal(entry.country, 'United Kingdom');
    assert.equal(entry.countryCode, 'GB');
    assert.match(entry.postalCode, /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/, `${entry.id} postcode`);
    assert.match(entry.emailDomain, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${entry.id} mail domain`);
    assert.ok(entry.programs.length >= 4, `${entry.id} programs`);
  }

  const seed = 'eeeeeeeeeeeeeeeeeeeeeeee';
  const identity = generateUKIdentity(seed, universities[0], { now: NOW });
  assert.equal(identity.university.countryCode, 'GB');
  assert.equal(identity.email, `${transliterateUK(identity.firstName).toLowerCase()}.${transliterateUK(identity.lastName).toLowerCase()}@${universities[0].emailDomain}`);
  assert.equal(ukDate('2026-09-25'), '25/09/2026', 'DD/MM/YYYY');
  assert.deepEqual(generateUKIdentity(seed, universities[0], { now: NOW }), identity);

  const registrar = generateUKRegistrar(seed);
  assert.ok(['University Registrar', 'Academic Registrar', 'Registrar'].includes(registrar.role));

  const bundle = buildIdentityBundle({ seed, university: universities[0], now: NOW });
  assert.equal(bundle.university.countryCode, 'GB');
  const files = buildMaterialFiles({ ...identity, issueDate: '2026-11-17', registrar });
  assert.deepEqual(files.map(file => file.name), Object.values(MATERIAL_KINDS));
  assert.equal(materialSummary(bundle, files).university.country, 'United Kingdom');

  for (const file of files) {
    assert.ok(file.bytes.length > 2000 && file.bytes.length < 20 * 1024 * 1024, `${file.name} size`);
    const text = file.bytes.toString('latin1');
    for (const needle of [identity.lastName, identity.studentNumber, identity.program]) {
      assert.ok(text.includes(needle), `${file.name} contains ${needle}`);
    }
    assert.ok(!/\(xxx\)|placeholder/i.test(text), `${file.name} has no placeholder text`);
  }
});
