import { buildEnrollmentCertificate, buildSemesterCertificate } from './certificate-layout.js';
import { ukDate } from '../core/uk-identity.js';

// UK enrollment certificates — same official layout as the US builder,
// localized for the United Kingdom: DD/MM/YYYY dates, credit wording suited to
// the UK (degree-programme, no credit-hour system), and UK academic terms
// (Autumn/Spring/Summer) carried by the identity bundle from uk-identity.js.

const LOCALE = Object.freeze({
  date: ukDate,
  creditsLabel: 'Full-time (undergraduate degree programme)',
  sealCaption: 'THE REGISTRAR',
});

export function buildEnrollmentCertificateLocal(identity) {
  return buildEnrollmentCertificate(identity, LOCALE);
}

export function buildSemesterCertificateLocal(identity) {
  return buildSemesterCertificate(identity, LOCALE);
}

export { LOCALE as ukCertificateLocale };
