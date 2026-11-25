import { createHash } from 'node:crypto';
import { FEMALE_FIRST_NAMES, MALE_FIRST_NAMES, LAST_NAMES, usDate } from '../core/us-identity.js';
import {
  buildEnrollmentCertificate as buildCertificate,
  buildSemesterCertificate as buildSemester,
} from './certificate-layout.js';

function seeded(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(4) || 3;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length) % list.length];

export function generateRegistrar(seed) {
  const random = seeded(`${seed}:registrar`);
  const female = random() < 0.5;
  return {
    title: pick(random, female ? ['Dr.', 'Ms.', 'Mrs.', ''] : ['Dr.', 'Mr.', '']),
    firstName: pick(random, female ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES),
    lastName: pick(random, LAST_NAMES),
    role: 'University Registrar',
    female,
  };
}

const US_LOCALE = Object.freeze({
  date: usDate,
  creditsLabel: 'Full-time (12+ credits)',
});

export function buildEnrollmentCertificate(identity) {
  return buildCertificate(identity, US_LOCALE);
}

export function buildSemesterCertificate(identity) {
  return buildSemester(identity, US_LOCALE);
}
