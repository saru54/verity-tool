import { buildEnrollmentCertificate, buildSemesterCertificate } from './certificate-layout.js';
import { caDate } from '../core/ca-identity.js';

// Canadian enrollment certificates — same official layout as the US builder,
// localized for Canada: DD/MM/YYYY dates, "full course load" credit wording,
// and Canadian academic terms (Fall/Winter/Spring-Summer) carried by the
// identity bundle from ca-identity.js.

const LOCALE = Object.freeze({
  date: caDate,
  creditsLabel: 'Full-time (full course load)',
  sealCaption: 'THE REGISTRAR',
});

export function buildEnrollmentCertificateLocal(identity) {
  return buildEnrollmentCertificate(identity, LOCALE);
}

export function buildSemesterCertificateLocal(identity) {
  return buildSemesterCertificate(identity, LOCALE);
}

export { LOCALE as caCertificateLocale };
