import { AutomationError } from '../../core/errors.js';

// SheerID programs differ by segment (student, teacher, military…), country and
// locale. A program URL + the initialize response carry enough to derive a
// profile so the rest of the system can adapt instead of assuming Germany-only.

// Map SheerID segment → the collect-step name used for that segment's form.
const SEGMENT_STEPS = Object.freeze({
  student: 'collectStudentPersonalInfo',
  teacher: 'collectTeacherPersonalInfo',
  member: 'collectMilitaryPersonalInfo',
  firstResponder: 'collectFirstResponderPersonalInfo',
  medical: 'collectMedicalPersonalInfo',
  employment: 'collectEmploymentPersonalInfo',
});

// Map SheerID segment → our materials "kind" set and form field expectations.
const SEGMENT_PROFILES = Object.freeze({
  student: {
    step: 'collectStudentPersonalInfo',
    // SheerID's student form always asks for: first name, last name, email,
    // birth date, school, country, and optionally student status + consent.
    fields: ['country', 'organization', 'firstName', 'lastName', 'birthMonth', 'birthDay', 'birthYear', 'email', 'consent'],
  },
  teacher: {
    step: 'collectTeacherPersonalInfo',
    fields: ['country', 'organization', 'firstName', 'lastName', 'email'],
  },
});

// Derive a program profile from a SheerID URL's query params.
// Returns { programId, country, locale } where country/locale may be null.
export function parseProgramFromUrl(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/verify\/([a-f\d]{24})/i);
  if (!match) throw new AutomationError('INVALID_CONFIG', 'URL 路径不包含有效的 programId');
  return {
    programId: match[1].toLowerCase(),
    country: parsed.searchParams.get('country')?.toUpperCase() || null,
    locale: parsed.searchParams.get('locale') || null,
    originalUrl: url,
  };
}

// Enrich the parsed profile with fields from the SheerID initialize response.
export function buildProgramProfile(parsed, initResponse) {
  const segment = initResponse?.segment ?? 'student';
  const profile = SEGMENT_PROFILES[segment] ?? SEGMENT_PROFILES.student;
  return Object.freeze({
    programId: parsed.programId,
    // The URL's country param is authoritative (operator chose it); fall back
    // to the server's value only if the URL didn't specify one.
    country: parsed.country ?? (initResponse?.country || null),
    locale: parsed.locale ?? initResponse?.locale ?? 'en',
    segment,
    step: profile.step,
    fields: profile.fields,
    availableStatuses: initResponse?.availableStatuses ?? [],
    verificationId: initResponse?.verificationId ?? null,
    originalUrl: parsed.originalUrl,
  });
}

// Resolve the materials-country for a program profile.
// US is the default and fully supported with real university + enrollment PDF data.
// DE (Germany) is also supported with its own dataset and certificate templates.
// Other countries fall back to US with a logged warning until their own
// university dataset and certificate templates are added.
export function materialsCountry(profile) {
  if (!profile?.country || profile.country === 'US') return 'United States';
  if (profile.country === 'DE') return 'Germany';
  // Non-US/DE programs: the form country needs to match the program's country,
  // but the document template defaults to US for now. The operator can override
  // config.data.country explicitly if a different country is required.
  return null; // null = use whatever config.data.country says
}

// Resolve the SheerID form country label for a program profile.
// Returns the English country name the form's country dropdown expects.
// When the program profile has no country (old URL format without ?country=),
// we default to United States for backward compatibility.
export function formCountryLabel(profile, fallback = 'United States') {
  // No URL-derived country: use the caller's fallback (defaults to the
  // backward-compatible US-first label when nothing else is known).
  if (!profile?.country) return fallback;
  const map = {
    DE: 'Germany',
    SG: 'Singapore',
    US: 'United States',
    GB: 'United Kingdom',
    FR: 'France',
    ES: 'Spain',
    IT: 'Italy',
    NL: 'Netherlands',
    AT: 'Austria',
    CH: 'Switzerland',
    AU: 'Australia',
    CA: 'Canada',
    JP: 'Japan',
    KR: 'South Korea',
    BR: 'Brazil',
    MX: 'Mexico',
    IN: 'India',
  };
  return map[profile.country] ?? fallback;
}

export { SEGMENT_STEPS };
