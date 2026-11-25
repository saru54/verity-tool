import { createHash } from 'node:crypto';

// Canada identity data used for SheerID university enrollment material.
// Names are a mix of English-Canadian and French-Canadian given names and
// surnames, drawn from real Canadian name statistics; every composed value is
// a plausible full identity, never a placeholder.
//
// This module mirrors the API and shape of us-identity.js exactly, swapping in
// Canada-specific data (postal codes, provinces, DD/MM/YYYY dates, Canadian
// academic terms) anywhere the locale changes behavior. The identity object
// returned by generateIdentity() has the same fields as the US generator
// except where the locale forces a difference (noted inline).

// ---------------------------------------------------------------------------
// Given names — English-Canadian first, then French-Canadian (with diacritics,
// which transliterate() normalizes down to ASCII for email local parts).
// ---------------------------------------------------------------------------
const MALE_FIRST_NAMES = [
  // English-Canadian
  'Alexander', 'Andrew', 'Anthony', 'Austin', 'Benjamin', 'Brandon', 'Brian', 'Caleb',
  'Cameron', 'Charles', 'Christian', 'Christopher', 'Connor', 'Daniel', 'David', 'Dominic',
  'Dylan', 'Edward', 'Elijah', 'Ethan', 'Evan', 'Gabriel', 'Gavin', 'George', 'Henry',
  'Hunter', 'Isaac', 'Jack', 'Jacob', 'James', 'Jared', 'Jason', 'John', 'Jonathan',
  'Joseph', 'Joshua', 'Justin', 'Kevin', 'Kyle', 'Liam', 'Logan', 'Lucas', 'Luke',
  'Mark', 'Mason', 'Matthew', 'Michael', 'Nathan', 'Nicholas', 'Noah', 'Oliver',
  'Owen', 'Ryan', 'Samuel', 'Scott', 'Stephen', 'Steven', 'Timothy', 'Tyler',
  'William', 'Zachary',
  // French-Canadian
  'Jean', 'Pierre', 'François', 'Antoine', 'Marc', 'Stéphane', 'Michel', 'Philippe',
  'Jacques', 'Louis', 'Réjean', 'André', 'Claude', 'Julien', 'Mathieu', 'Sébastien',
  'Frédéric', 'Éric', 'Denis', 'Patrick', 'Bruno', 'Sylvain', 'Yves', 'Gaétan',
  'Normand', 'Benoît', 'Laurent', 'Étienne', 'Maxime', 'Alexandre', 'Pascal', 'Vincent',
  'Simon', 'Hugo', 'Dominique', 'Olivier', 'Nicolas', 'Xavier', 'Martin', 'Gilles',
];
const FEMALE_FIRST_NAMES = [
  // English-Canadian
  'Abigail', 'Addison', 'Alexis', 'Alice', 'Allison', 'Amanda', 'Amber', 'Anna',
  'Arianna', 'Ashley', 'Aubrey', 'Audrey', 'Ava', 'Avery', 'Bailey', 'Bella',
  'Brianna', 'Brooke', 'Camila', 'Caroline', 'Charlotte', 'Chloe', 'Claire', 'Courtney',
  'Crystal', 'Danielle', 'Elizabeth', 'Ella', 'Ellie', 'Emily', 'Emma', 'Erin',
  'Evelyn', 'Faith', 'Grace', 'Hailey', 'Hannah', 'Harper', 'Isabella', 'Jasmine',
  'Jennifer', 'Jessica', 'Julia', 'Kate', 'Kayla', 'Kelsey', 'Kimberly', 'Kyla',
  'Lauren', 'Layla', 'Leah', 'Lila', 'Lily', 'Mackenzie', 'Madison', 'Makayla',
  'Megan', 'Mia', 'Natalie', 'Olivia', 'Paige', 'Peyton', 'Rachel', 'Rebecca',
  'Riley', 'Samantha', 'Sarah', 'Stella', 'Sydney', 'Taylor', 'Zoe',
  // French-Canadian
  'Marie', 'Catherine', 'Julie', 'Sophie', 'Sophia', 'Geneviève', 'Isabelle', 'Nathalie',
  'Chantal', 'Manon', 'Sylvie', 'Brigitte', 'Hélène', 'Josée', 'Francine', 'Louise',
  'Pascale', 'Véronique', 'Martine', 'Céline', 'Jacinthe', 'Guylaine', 'Monique', 'Thérèse',
  'Anne', 'Stéphanie', 'Mireille', 'Émilie', 'Amélie', 'Mélissa', 'Karine', 'Joëlle',
  'Pierrette', 'Lise', 'Diane', 'Denise', 'Carole', 'Sylvaine', 'Andrée', 'Suzanne',
];
// Surnames — English-Canadian and French-Canadian. French-Canadian surnames
// (Tremblay, Gagnon, Côté, Bélanger, …) are among the most common in Quebec.
const LAST_NAMES = [
  // English-Canadian
  'Adams', 'Alexander', 'Allen', 'Anderson', 'Bailey', 'Baker', 'Barnes', 'Bell',
  'Bennett', 'Brooks', 'Brown', 'Bryant', 'Burns', 'Butler', 'Campbell', 'Carter',
  'Clark', 'Coleman', 'Collins', 'Cook', 'Cooper', 'Cox', 'Cruz', 'Davis',
  'Edwards', 'Evans', 'Fisher', 'Flores', 'Foster', 'Garcia', 'Gomez', 'Gray',
  'Green', 'Griffin', 'Hall', 'Harris', 'Hayes', 'Henderson', 'Hernandez', 'Hill',
  'Howard', 'Hughes', 'Jackson', 'James', 'Jenkins', 'Johnson', 'Jones', 'Jordan',
  'Kelly', 'King', 'Lee', 'Lewis', 'Long', 'Martin', 'Martinez', 'Mason',
  'Matthews', 'Miller', 'Mitchell', 'Moore', 'Morgan', 'Morris', 'Murphy', 'Murray',
  'Nelson', 'Nguyen', 'Oliver', 'Owens', 'Parker', 'Patel', 'Perez', 'Perry',
  'Peterson', 'Phillips', 'Powell', 'Reed', 'Reyes', 'Reynolds', 'Richardson', 'Roberts',
  'Robinson', 'Rodriguez', 'Rogers', 'Ross', 'Russell', 'Sanchez', 'Sanders', 'Scott',
  'Simmons', 'Smith', 'Stewart', 'Sullivan', 'Taylor', 'Thomas', 'Thompson', 'Torres',
  'Turner', 'Walker', 'Wallace', 'Ward', 'Watson', 'White', 'Williams', 'Wilson',
  'Wood', 'Wright', 'Young', 'MacDonald', 'MacKenzie', 'Cunningham', 'Fraser', 'Gordon',
  // French-Canadian
  'Tremblay', 'Gagnon', 'Roy', 'Côté', 'Bouchard', 'Gauthier', 'Morin', 'Lavoie',
  'Fortin', 'Gagné', 'Pelletier', 'Bélanger', 'Lévesque', 'Bergeron', 'Leblanc', 'Moreau',
  'Cloutier', 'Turcotte', 'Lapointe', 'Dubé', 'Desjardins', 'Savard', 'Beaulieu', 'Lacroix',
  'Villeneuve', 'Caron', 'Thibault', 'Nadeau', 'Martel', 'Fournier', 'Proulx', 'Champagne',
  'Bernier', 'Richard', 'Verville', 'Lessard', 'Bissonnette', 'Pomerleau', 'Auclair', 'Binette',
];

// Birth places — major Canadian census metropolitan areas with province code.
// Format "City, XX" mirrors the US "City, XX" two-letter state convention.
const BIRTH_PLACES = [
  'Toronto, ON', 'Vancouver, BC', 'Montreal, QC', 'Calgary, AB', 'Edmonton, AB',
  'Ottawa, ON', 'Winnipeg, MB', 'Quebec City, QC', 'Hamilton, ON', 'Halifax, NS',
  'Victoria, BC', 'Saskatoon, SK', 'Regina, SK', 'London, ON', 'Mississauga, ON',
  'Brampton, ON', 'Oshawa, ON', 'Windsor, ON', 'Kitchener, ON', 'Markham, ON',
  'Vaughan, ON', 'Kingston, ON', 'Richmond Hill, ON', 'Burnaby, BC', 'Surrey, BC',
  'Coquitlam, BC', 'Kelowna, BC', 'Abbotsford, BC', 'Langley, BC', 'Saanich, BC',
  'Lethbridge, AB', 'Red Deer, AB', 'Medicine Hat, AB', 'St. Albert, AB',
  'Fort McMurray, AB', 'Sherwood Park, AB', 'Laval, QC', 'Gatineau, QC',
  'Longueuil, QC', 'Sherbrooke, QC', 'Saguenay, QC', 'Trois-Rivières, QC',
  'Terrebonne, QC', 'Saint-Jean-sur-Richelieu, QC', 'Dollard-des-Ormeaux, QC',
  'Repentigny, QC', 'Brossard, QC', 'Granby, QC', 'Saint-Jérôme, QC',
  'Drummondville, QC', 'Saint-Hyacinthe, QC', 'Fredericton, NB', 'Moncton, NB',
  'Saint John, NB', 'Charlottetown, PE', 'Summerside, PE', 'St. John\'s, NL',
  'Corner Brook, NL', 'Barrie, ON', 'Guelph, ON', 'Peterborough, ON',
  'Thunder Bay, ON', 'Sudbury, ON', 'Yellowknife, NT', 'Whitehorse, YT', 'Iqaluit, NU',
];

// Street names — typical Canadian street types, including French forms used
// in Quebec (Rue, Boulevard, Avenue, Chemin). Hyphens and apostrophes are
// preserved in the composed address; transliterate() strips them only where
// an email local part requires ASCII.
const STREETS = [
  // English-Canadian
  'Main St', 'King St', 'Queen St', 'Queen St W', 'Yonge St', 'Bay St', 'College St',
  'Bloor St W', 'Bloor St E', 'Dundas St W', 'Dundas St E', 'Spadina Ave', 'Bank St',
  'Wellington St', 'Albert St', 'Elgin St', 'Laurier Ave W', 'Laurier Ave E', 'Rideau St',
  'Sussex Dr', 'Macleod Tr', '17th Ave SW', '4th St SW', 'Jasper Ave', 'Whyte Ave',
  'Granville St', 'Robson St', 'Davie St', 'Denman St', 'Burrard St', 'Homer St',
  'Church St', 'Front St', 'Adelaide St', 'Richmond St', 'York St', 'Bronson Ave',
  'Carling Ave', 'Baseline Rd', 'Hazeldean Rd', 'March Rd', 'Eagleson Rd',
  'Oak St', 'Maple St', 'Cedar St', 'Pine St', 'Elm St', 'Spring St', 'Mill St',
  'Walnut St', 'Park Ave', 'River St', 'Sunset Blvd', 'Broadway', 'Willow Ln',
  'Highland Ave', 'Bridge St', 'Cherry St', 'Hill St', 'Lake St', 'Forest St',
  // French-Canadian
  'Rue Sainte-Catherine', 'Boulevard Saint-Laurent', 'Rue Saint-Denis', 'Rue Sherbrooke',
  'Avenue du Mont-Royal', 'Rue Notre-Dame', 'Boulevard René-Lévesque', 'Rue Peel',
  'Rue McGill College', 'Rue Saint-Hubert', 'Chemin de la Côte-des-Neiges', 'Rue Ontario E',
  'Avenue Papineau', 'Boulevard Maisonneuve', 'Rue Beaubien', 'Rue Jean-Talon',
  'Rue Saint-Joseph', 'Avenue Laurier E', 'Avenue Laurier O', 'Rue Fleury', 'Rue d\'Iberville',
  'Rue de Castelnau', 'Boulevard Pie-IX', 'Rue Masson', 'Rue Bélanger', 'Rue Ontario W',
];

// All randomness derives from the seed so a verification task always resolves to
// the same identity, while independent tasks receive different identities.
// Identical to the US generator's xorshift32 seeded from SHA-256(seed).
function seededRandom(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length) % list.length];
const pad = (value, width = 2) => String(value).padStart(width, '0');

// Canadian postal codes use the form "L#L #L#". The first letter is drawn from
// the set of valid postal-area first letters (W,Z,D,F,I,O,Q,U excluded) so the
// generated code is structurally plausible for a real forward sortation area.
const POSTAL_FIRST_LETTERS = 'ABCEGHJKLMNPRSTVXY';
const POSTAL_LETTERS = 'ABCEGHJKLMNPRSTVWXYZ';
function generatePostalCode(random) {
  const L = (set) => set[Math.floor(random() * set.length)];
  const D = () => Math.floor(random() * 10);
  return `${L(POSTAL_FIRST_LETTERS)}${D()}${L(POSTAL_LETTERS)} ${D()}${L(POSTAL_LETTERS)}${D()}`;
}

// Transliteration handles French-Canadian diacritics: é→e, è→e, ê→e, ë→e, à→a,
// â→a, ç→c, î→i, ï→i, ô→o, ù→u, û→u, ü→u, É→E, È→E, …. NFD decomposition peels
// the combining marks off precomposed characters; the ligatures œ/æ (which NFD
// leaves intact as single code points) are expanded first so they are not lost.
// The trailing replace mirrors the US generator, collapsing hyphens/apostrophes
// for use in email local parts (e.g. "François" → "francois").
export function transliterate(value) {
  const ligatures = { 'œ': 'oe', 'Œ': 'OE', 'æ': 'ae', 'Æ': 'AE', 'ß': 'ss' };
  return String(value)
    .replace(/[œŒæÆß]/g, (m) => ligatures[m] ?? m)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '');
}

// Canadian academic terms: Fall (Sep–Dec), Winter (Jan–Apr), Spring/Summer (May–Aug).
// Most Canadian universities use Fall as the primary enrollment term; the
// Jan–Apr term is called "Winter" (where the US uses "Spring"), and the May–Aug
// term is "Spring/Summer" (where the US uses "Summer").
export function currentSemester(now = new Date()) {
  const month = now.getMonth() + 1;
  if (month >= 9) {
    return {
      kind: 'Fall', label: `Fall ${now.getFullYear()}`,
      start: `${now.getFullYear()}-09-08`, end: `${now.getFullYear()}-12-15`,
    };
  }
  if (month <= 4) {
    return {
      kind: 'Winter', label: `Winter ${now.getFullYear()}`,
      start: `${now.getFullYear()}-01-06`, end: `${now.getFullYear()}-04-09`,
    };
  }
  return {
    kind: 'Summer', label: `Spring/Summer ${now.getFullYear()}`,
    start: `${now.getFullYear()}-05-01`, end: `${now.getFullYear()}-08-31`,
  };
}

// Move `back` terms into the past:
// Fall 2026 → Spring/Summer 2026 → Winter 2026 → Fall 2025 → …
// (reverse-chronological adjacency mirrors the US generator, with Winter in
// place of the US Spring slot).
export function shiftSemester(semester, back) {
  const order = ['Fall', 'Summer', 'Winter'];
  let year = Number(semester.start.slice(0, 4));
  let kind = semester.kind;
  for (let step = 0; step < back; step++) {
    const idx = order.indexOf(kind);
    const nextIdx = (idx + 1) % order.length;
    kind = order[nextIdx];
    if (nextIdx === 0) year -= 1; // wrapped past Fall → previous year
  }
  const start = kind === 'Fall' ? `${year}-09-08` : kind === 'Winter' ? `${year}-01-06` : `${year}-05-01`;
  const end = kind === 'Fall' ? `${year}-12-15` : kind === 'Winter' ? `${year}-04-09` : `${year}-08-31`;
  const label = kind === 'Summer' ? `Spring/Summer ${year}` : `${kind} ${year}`;
  return { kind, label, start, end };
}

// Canadian date format: DD/MM/YYYY (day-first, unlike the US MM/DD/YYYY).
export function caDate(value) {
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

// Canadian universities issue 8–9 digit student numbers; the exact width is
// driven by the university record (matriculationDigits), defaulting to 8.
export function generateStudentNumber(university, random) {
  const digits = university.matriculationDigits ?? 8;
  const prefix = university.matriculationPrefix ?? '';
  let body = String(1 + Math.floor(random() * 8));
  while (body.length < digits - prefix.length) body += Math.floor(random() * 10);
  return `${prefix}${body}`;
}

export function generateIdentity(seed, university, { now = new Date() } = {}) {
  const random = seededRandom(seed);
  const female = random() < 0.5;
  const firstName = pick(random, female ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES);
  const middleName = random() < 0.35 ? pick(random, female ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES) : '';
  const lastName = pick(random, LAST_NAMES);
  // Enrolled students are typically 18–28 years old; bias towards 20–24.
  const age = Math.min(28, 18 + Math.floor(random() * 4) + Math.floor(random() * 4) + Math.floor(random() * 4));
  const birthYear = now.getFullYear() - age;
  const birthMonth = 1 + Math.floor(random() * 12);
  const daysInMonth = new Date(Date.UTC(birthYear, birthMonth, 0)).getUTCDate();
  const birthDay = 1 + Math.floor(random() * daysInMonth);
  const birthDate = `${birthYear}-${pad(birthMonth)}-${pad(birthDay)}`;
  const birthPlace = pick(random, BIRTH_PLACES);
  const street = pick(random, STREETS);
  const houseNumber = 1 + Math.floor(random() * 9999);
  const postalCode = generatePostalCode(random);
  const semester = currentSemester(now);
  // Canadian students refer to year of study as "First Year" … "Fourth Year",
  // rather than the US Freshman/Sophomore/Junior/Senior labels.
  const academicYear = 1 + Math.floor(random() * 4); // First Year(1) – Fourth Year(4)
  const enrolledSince = shiftSemester(semester, Math.max(0, (academicYear - 1) * 3));
  const emailLocal = `${transliterate(firstName).toLowerCase()}.${transliterate(lastName).toLowerCase()}`;
  const program = pick(random, university.programs ?? ['B.Sc. Computer Science']);
  const academicYearLabel = ['', 'First Year', 'Second Year', 'Third Year', 'Fourth Year'][academicYear] ?? 'Student';
  return Object.freeze({
    firstName,
    middleName,
    lastName,
    fullName: [firstName, middleName, lastName].filter(Boolean).join(' '),
    birthDate,
    birthPlace,
    // The student's residential address keeps the US shape ({ street, postalCode,
    // city, state }); here `postalCode` is a Canadian "L#L #L#" code and `state`
    // carries the province. The university's own province code is on
    // university.stateCode.
    address: {
      street: `${houseNumber} ${street}`,
      postalCode,
      city: university.city,
      state: university.state,
    },
    email: `${emailLocal}@${university.emailDomain}`,
    studentNumber: generateStudentNumber(university, random),
    program,
    academicYear,
    academicYearLabel,
    enrolledSince: enrolledSince.label,
    semester,
    // The university block has the same fields as the US generator, but
    // country/countryCode default to Canada/CA. state holds the province name
    // (e.g. "Ontario") and stateCode the two-letter province code (ON, QC, BC, AB).
    university: {
      id: university.id, name: university.name, shortName: university.shortName,
      city: university.city, state: university.state, stateCode: university.stateCode,
      country: university.country ?? 'Canada', countryCode: university.countryCode ?? 'CA',
      street: university.street, postalCode: university.postalCode,
      phone: university.phone, website: university.website, registrar: university.registrar,
      emailDomain: university.emailDomain,
    },
  });
}

export function generateRegistrar(seed) {
  const random = seededRandom(`${seed}:registrar`);
  const female = random() < 0.5;
  // Canadian registrar offices use "Registrar" and the Associate/Assistant/
  // Deputy variants; the title list is gender-neutral.
  const roleOptions = ['University Registrar', 'Associate Registrar', 'Assistant Registrar', 'Deputy Registrar'];
  return {
    title: pick(random, female ? ['Dr.', 'Ms.', 'Mrs.', 'Mme.', ''] : ['Dr.', 'Mr.', 'M.', '']),
    firstName: pick(random, female ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES),
    lastName: pick(random, LAST_NAMES),
    role: pick(random, roleOptions),
    female,
  };
}

export {
  MALE_FIRST_NAMES,
  FEMALE_FIRST_NAMES,
  LAST_NAMES,
  BIRTH_PLACES,
  STREETS,
};
