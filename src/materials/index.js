import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateIdentity as generateGermanIdentity } from '../core/german-identity.js';
import { generateIdentity as generateUSIdentity, generateRegistrar as generateUSRegistrar } from '../core/us-identity.js';
import { generateIdentity as generateCAIdentity, generateRegistrar as generateCARegistrar } from '../core/ca-identity.js';
import { generateIdentity as generateUKIdentity, generateRegistrar as generateUKRegistrar } from '../core/uk-identity.js';
import { buildEnrollmentCertificate as buildGermanEnrollment, buildSemesterCertificate as buildGermanSemester, generateRegistrar as generateGermanRegistrar } from './enrollment.js';
import { buildEnrollmentCertificate as buildUSEnrollment, buildSemesterCertificate as buildUSSemester } from './us-enrollment.js';
import { buildEnrollmentCertificateLocal as buildCAEnrollment, buildSemesterCertificateLocal as buildCASemester } from './ca-enrollment.js';
import { buildEnrollmentCertificateLocal as buildUKEnrollment, buildSemesterCertificateLocal as buildUKSemester } from './uk-enrollment.js';

const UNIVERSITY_FILES = {
  de: fileURLToPath(new URL('../data/universities.de.json', import.meta.url)),
  us: fileURLToPath(new URL('../data/universities.us.json', import.meta.url)),
  ca: fileURLToPath(new URL('../data/universities.ca.json', import.meta.url)),
  gb: fileURLToPath(new URL('../data/universities.gb.json', import.meta.url)),
};

// Map ISO country code → dataset key. Used by pickUniversity and loadUniversities.
const COUNTRY_TO_KEY = { DE: 'de', US: 'us', CA: 'ca', GB: 'gb' };
const KEY_TO_COUNTRY = { de: 'Germany', us: 'United States', ca: 'Canada', gb: 'United Kingdom' };

const universityCache = new Map();

export async function loadUniversities(countryKey = 'us') {
  if (!universityCache.has(countryKey)) {
    const file = UNIVERSITY_FILES[countryKey];
    if (!file) throw new Error(`Unknown university dataset: ${countryKey}`);
    const raw = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    if (!Array.isArray(raw) || raw.length === 0) throw new Error(`University dataset (${countryKey}) is empty`);
    universityCache.set(countryKey, Object.freeze(raw.map(entry => Object.freeze(entry))));
  }
  return universityCache.get(countryKey);
}

// Detect the country key from a university ID prefix or explicit country code.
// US universities use plain IDs like "mit", "stanford".
// German universities use IDs like "tum", "lmu", "rwth".
// When universityId is provided, try each dataset in order (US first, then DE).
export async function pickUniversity({ universityId, seed, countryCode } = {}) {
  const key = countryCode ? (COUNTRY_TO_KEY[countryCode?.toUpperCase()] ?? 'us') : 'us';
  if (universityId) {
    // Search the requested dataset first, then fall back to the other.
    for (const k of [key, ...Object.keys(UNIVERSITY_FILES).filter(k2 => k2 !== key)]) {
      const universities = await loadUniversities(k);
      const found = universities.find(entry => entry.id === universityId);
      if (found) return found;
    }
    throw new Error(`Unknown university ID: ${universityId}`);
  }
  const universities = await loadUniversities(key);
  return seededPick(seed ?? 'default', universities);
}

function seededPick(seed, list) {
  const digest = createHash('sha256').update(String(seed)).digest();
  return list[digest.readUInt32LE(0) % list.length];
}

// Identity + registrar + issue date in one deterministic bundle. Re-running the
// same verificationId reproduces the exact material, which is what a second
// review round needs. Dispatches to the correct country's identity generator.
export function buildIdentityBundle({ seed, university, now = new Date() }) {
  const countryCode = university.countryCode ?? (university.country === 'United States' ? 'US' : 'DE');
  const identity = countryCode === 'US'
    ? generateUSIdentity(seed, university, { now })
    : countryCode === 'CA'
      ? generateCAIdentity(seed, university, { now })
      : countryCode === 'GB'
        ? generateUKIdentity(seed, university, { now })
        : generateGermanIdentity(seed, university, { now });
  const issueDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const registrar = countryCode === 'US'
    ? generateUSRegistrar(seed)
    : countryCode === 'CA'
      ? generateCARegistrar(seed)
      : countryCode === 'GB'
        ? generateUKRegistrar(seed)
        : generateGermanRegistrar(seed);
  return Object.freeze({ ...identity, issueDate, registrar });
}

export const MATERIAL_KINDS = Object.freeze({
  enrollment: 'enrollment-certificate.pdf',
  semester: 'term-verification.pdf',
});

// Build material files for one identity: country-specific enrollment + term certificates.
export function buildMaterialFiles(identity) {
  const countryCode = identity.university?.countryCode ?? (identity.university?.country === 'United States' ? 'US' : 'DE');
  if (countryCode === 'US') {
    return [
      { name: MATERIAL_KINDS.enrollment, mimeType: 'application/pdf', bytes: buildUSEnrollment(identity) },
      { name: MATERIAL_KINDS.semester, mimeType: 'application/pdf', bytes: buildUSSemester(identity) },
    ];
  }
  if (countryCode === 'CA') {
    return [
      { name: MATERIAL_KINDS.enrollment, mimeType: 'application/pdf', bytes: buildCAEnrollment(identity) },
      { name: MATERIAL_KINDS.semester, mimeType: 'application/pdf', bytes: buildCASemester(identity) },
    ];
  }
  if (countryCode === 'GB') {
    return [
      { name: MATERIAL_KINDS.enrollment, mimeType: 'application/pdf', bytes: buildUKEnrollment(identity) },
      { name: MATERIAL_KINDS.semester, mimeType: 'application/pdf', bytes: buildUKSemester(identity) },
    ];
  }
  // German materials use the original German filenames for backward compatibility.
  return [
    { name: 'immatrikulationsbescheinigung.pdf', mimeType: 'application/pdf', bytes: buildGermanEnrollment(identity) },
    { name: 'semesterbescheinigung.pdf', mimeType: 'application/pdf', bytes: buildGermanSemester(identity) },
  ];
}

export function materialSummary(identity, files) {
  const countryCode = identity.university?.countryCode ?? (identity.university?.country === 'United States' ? 'US' : 'DE');
  const country = KEY_TO_COUNTRY[COUNTRY_TO_KEY[countryCode] ?? 'us'];
  return {
    university: identity.university,
    organization: {
      name: identity.university.name,
      optionText: identity.university.name,
      emailDomain: identity.university.emailDomain,
      country,
    },
    files: files.map(file => ({
      name: file.name, mimeType: file.mimeType, size: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    })),
    identity: {
      firstName: identity.firstName, lastName: identity.lastName, middleName: identity.middleName,
      fullName: identity.fullName, birthDate: identity.birthDate, birthPlace: identity.birthPlace,
      email: identity.email, studentNumber: identity.studentNumber, program: identity.program,
      academicYear: identity.academicYear, academicYearLabel: identity.academicYearLabel,
      fachSemester: identity.fachSemester, enrolledSince: identity.enrolledSince,
      address: identity.address, salutation: identity.salutation,
      semester: identity.semester, issueDate: identity.issueDate, registrar: identity.registrar,
      university: identity.university,
    },
  };
}
