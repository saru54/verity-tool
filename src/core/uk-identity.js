import { createHash } from 'node:crypto';

// UK (United Kingdom) identity data used for SheerID university verification
// material. Names are drawn from real British name statistics — a deliberate
// mix of English, Scottish, Welsh and Irish names so every composed value is a
// plausible full identity, never a placeholder.

const MALE_FIRST_NAMES = [
  // English
  'Adam', 'Alfie', 'Arthur', 'Benjamin', 'Callum', 'Charlie', 'Daniel', 'David',
  'Edward', 'Ethan', 'Freddie', 'George', 'Harry', 'Henry', 'Jack', 'Jacob',
  'James', 'John', 'Joseph', 'Joshua', 'Lewis', 'Liam', 'Lucas', 'Mark',
  'Mason', 'Matthew', 'Michael', 'Noah', 'Oliver', 'Oscar', 'Richard', 'Robert',
  'Samuel', 'Sam', 'Thomas', 'William',
  // Scottish
  'Angus', 'Callan', 'Cameron', 'Duncan', 'Ewan', 'Finlay', 'Fraser', 'Hamish',
  'Lachlan', 'Niall', 'Roderick', 'Ross', 'Ruaridh', 'Stuart', 'Gregor',
  // Welsh
  'Dylan', 'Gethin', 'Gruffudd', 'Hywel', 'Owain', 'Rhys', 'Sion', 'Tudor',
  // Irish
  'Aidan', 'Cillian', 'Conor', 'Declan', 'Darragh', 'Finn', 'Lorcan', 'Oisin',
  'Padraig', 'Ronan', 'Sean', 'Ciaran', 'Brendan',
];
const FEMALE_FIRST_NAMES = [
  // English
  'Ada', 'Alice', 'Amelia', 'Ava', 'Bella', 'Charlotte', 'Chloe', 'Daisy',
  'Eleanor', 'Elsie', 'Emily', 'Emma', 'Erin', 'Evelyn', 'Evie', 'Florence',
  'Freya', 'Grace', 'Hannah', 'Harper', 'Ivy', 'Jessica', 'Lily', 'Lucy',
  'Maisy', 'Maya', 'Mia', 'Molly', 'Olivia', 'Penelope', 'Phoebe', 'Poppy',
  'Rosie', 'Ruby', 'Sophia', 'Sophie', 'Willow', 'Zara',
  // Scottish
  'Bonnie', 'Caitlin', 'Eilidh', 'Iona', 'Isla', 'Maisie', 'Robina', 'Skye',
  // Welsh
  'Aoibhe', 'Bethan', 'Carys', 'Eleri', 'Ffion', 'Gwen', 'Lowri', 'Nia',
  'Rhiannon', 'Seren',
  // Irish
  'Aoife', 'Caoimhe', 'Ciara', 'Clodagh', 'Mairead', 'Niamh', 'Orla', 'Saoirse',
  'Sinead', 'Deirdre',
];
const LAST_NAMES = [
  // English (most common)
  'Adams', 'Baker', 'Bennett', 'Brown', 'Clarke', 'Cooper', 'Davies', 'Dixon',
  'Edwards', 'Evans', 'Green', 'Hall', 'Harris', 'Hill', 'Hughes',
  'Jackson', 'James', 'Johnson', 'Jones', 'Kelly', 'King', 'Lee', 'Lewis',
  'Martin', 'Mason', 'Mitchell', 'Moore', 'Morgan', 'Morris', 'Palmer', 'Parker',
  'Phillips', 'Roberts', 'Robinson', 'Russell', 'Smith', 'Taylor', 'Thomas',
  'Thompson', 'Walker', 'Walsh', 'Watson', 'White', 'Williams', 'Wilson',
  'Wood', 'Wright', 'Young',
  // Scottish
  'Cameron', 'Campbell', 'Fraser', 'Gray', 'Henderson', 'MacDonald', 'MacLeod',
  'McGregor', 'McKenzie', 'McLean', 'Murray', 'Paterson', 'Reid', 'Robertson',
  'Ross', 'Stewart', 'Sutherland',
  // Welsh
  'Bowen', 'Davis', 'Griffiths', 'Howells', 'Hughes', 'Jenkins', 'Lloyd',
  'Morgan', 'Owen', 'Owens', 'Parry', 'Price', 'Pritchard', 'Rees', 'Rhys',
  'Rowlands', 'Vaughan', 'Watkins', 'Williams', 'Wynne',
  // Irish
  'Brennan', 'Byrne', 'Daly', 'Doyle', 'Gallagher', 'Kennedy', 'Kelly', 'Lynch',
  'Maher', 'McCarthy', 'Murphy', "O'Brien", "O'Connor", "O'Neill", "O'Sullivan",
  'Quinn', 'Ryan', 'Walsh',
];
const BIRTH_PLACES = [
  'London', 'Birmingham', 'Leeds', 'Glasgow', 'Sheffield', 'Bradford',
  'Manchester', 'Edinburgh', 'Liverpool', 'Bristol', 'Cardiff', 'Belfast',
  'Leicester', 'Coventry', 'Newcastle upon Tyne', 'Nottingham', 'Southampton',
  'Derby', 'Plymouth', 'Reading', 'Stoke-on-Trent', 'Wolverhampton', 'Aberdeen',
  'Dundee', 'Swansea', 'Newport', 'York', 'Oxford', 'Cambridge', 'Hull',
  'Exeter', 'Norwich', 'Brighton', 'Bolton', 'Sunderland', 'Inverness',
  'Bangor', 'Lisburn', 'Preston', 'St. Albans',
];
const STREETS = [
  'High Street', 'Station Road', 'Main Street', 'Church Lane', 'Mill Lane',
  'Park Road', 'Church Road', 'Victoria Road', 'The Avenue', 'Queens Road',
  'New Road', 'The Street', 'Manor Road', 'School Lane', 'King Street',
  'Queen Street', 'Church Street', 'Market Place', 'Fore Street', 'School Road',
  'York Road', 'London Road', 'Park Lane', 'Victoria Street', 'Albert Road',
  'Windsor Drive', 'Chestnut Avenue', 'Willow Close', 'Oak Lane', 'Maple Road',
  'Beech Drive', 'Lime Tree Avenue', 'The Green', 'The Causeway', 'West Street',
  'North Street', 'South Street', 'East Street', 'Mill Hill', 'St. Johns Road',
];

// All randomness derives from the seed so a verification task always resolves to
// the same identity, while independent tasks receive different identities.
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

// Characters allowed in each position of a UK postcode. UK postcodes exclude
// certain letters from the inward code and the first position; using these pools
// keeps generated postcodes visually consistent with real ones ("SW1A 1AA").
const FIRST_POS_LETTERS = 'ABDEGLMNOPRSTUWY'; // plausible first-position letters
const ANY_LETTER = 'ABDEFGHJKLMNPRSTUWY';     // inward/sub-district letters
const charPick = (random, pool) => pool[Math.floor(random() * pool.length)];

// Build a realistic-looking UK postcode matching the outward+inward format,
// e.g. "SW1A 1AA", "M4 9AB", "BS16 3FG", "EH9 2PR".
function generatePostcode(random) {
  const districtDigit = String(1 + Math.floor(random() * 9));
  let outward = charPick(random, FIRST_POS_LETTERS);
  if (random() < 0.6) outward += charPick(random, ANY_LETTER); // second area letter
  outward += districtDigit;
  if (random() < 0.25) outward += charPick(random, ANY_LETTER); // sub-district letter
  const inward = `${Math.floor(random() * 10)}${charPick(random, ANY_LETTER)}${charPick(random, ANY_LETTER)}`;
  return `${outward} ${inward}`;
}

// UK names are almost entirely ASCII; the odd Irish fada (Seán) or Welsh accent
// is handled by stripping combining marks, mirroring the US function for parity.
export function transliterate(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '');
}

// UK academic terms: Autumn (Sep–Dec), Spring (Jan–Apr), Summer (May–Jun).
// UK universities treat Autumn as the start of the academic year.
// July–August is the summer vacation; we report the upcoming Autumn term so a
// document generated during the break still resolves to a current enrolment.
export function currentSemester(now = new Date()) {
  const month = now.getMonth() + 1;
  if (month >= 9) {
    return {
      kind: 'Autumn', label: `Autumn ${now.getFullYear()}`,
      start: `${now.getFullYear()}-09-25`, end: `${now.getFullYear()}-12-15`,
    };
  }
  if (month <= 4) {
    return {
      kind: 'Spring', label: `Spring ${now.getFullYear()}`,
      start: `${now.getFullYear()}-01-12`, end: `${now.getFullYear()}-04-05`,
    };
  }
  if (month <= 6) {
    return {
      kind: 'Summer', label: `Summer ${now.getFullYear()}`,
      start: `${now.getFullYear()}-05-12`, end: `${now.getFullYear()}-06-20`,
    };
  }
  // July / August — summer vacation, point at the upcoming Autumn term.
  return {
    kind: 'Autumn', label: `Autumn ${now.getFullYear()}`,
    start: `${now.getFullYear()}-09-25`, end: `${now.getFullYear()}-12-15`,
  };
}

// Move `back` terms into the past: Autumn 2026 → Summer 2026 → Spring 2026 → Autumn 2025 → …
export function shiftSemester(semester, back) {
  const order = ['Autumn', 'Summer', 'Spring'];
  let year = Number(semester.start.slice(0, 4));
  let kind = semester.kind;
  for (let step = 0; step < back; step++) {
    const idx = order.indexOf(kind);
    const nextIdx = (idx + 1) % order.length;
    kind = order[nextIdx];
    if (nextIdx === 0) year -= 1; // wrapped past Autumn → previous year
  }
  const start = kind === 'Autumn' ? `${year}-09-25` : kind === 'Spring' ? `${year}-01-12` : `${year}-05-12`;
  const end = kind === 'Autumn' ? `${year}-12-15` : kind === 'Spring' ? `${year}-04-05` : `${year}-06-20`;
  return { kind, label: `${kind} ${year}`, start, end };
}

// UK date format: DD/MM/YYYY
export function ukDate(value) {
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

// UK student numbers are typically 8–9 digits. Per-university overrides
// (matriculationDigits / matriculationPrefix) take precedence, mirroring the US
// generator; the default of 8 sits inside the UK range.
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
  const middleName = random() < 0.2 ? pick(random, female ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES) : '';
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
  // UK house numbers on a residential street rarely reach three digits.
  const houseNumber = 1 + Math.floor(random() * 249);
  const postalCode = generatePostcode(random);
  const semester = currentSemester(now);
  // UK undergraduates are typically 1–4 years (Scotland / placement years reach 4).
  const academicYear = 1 + Math.floor(random() * 4);
  const enrolledSince = shiftSemester(semester, Math.max(0, (academicYear - 1) * 3));
  const emailLocal = `${transliterate(firstName).toLowerCase()}.${transliterate(lastName).toLowerCase()}`;
  const program = pick(random, university.programs ?? ['BSc Computer Science']);
  const academicYearLabel =
    ['', 'First Year', 'Second Year', 'Third Year', 'Final Year'][academicYear] ?? 'Student';
  // UK salutation. Male → Mr. Female students skew Ms/Miss; Mrs is uncommon but
  // possible, so it appears with low weight.
  const salutation = female
    ? pick(random, ['Ms', 'Ms', 'Ms', 'Ms', 'Ms', 'Miss', 'Miss', 'Miss', 'Miss', 'Mrs'])
    : 'Mr';
  return Object.freeze({
    salutation,
    firstName,
    middleName,
    lastName,
    fullName: [firstName, middleName, lastName].filter(Boolean).join(' '),
    birthDate,
    birthPlace,
    address: {
      street: `${houseNumber} ${street}`,
      postalCode,
      city: university.city,
      state: university.state, // UK: county
    },
    email: `${emailLocal}@${university.emailDomain}`,
    studentNumber: generateStudentNumber(university, random),
    program,
    academicYear,
    academicYearLabel,
    enrolledSince: enrolledSince.label,
    semester,
    university: {
      id: university.id,
      name: university.name,
      shortName: university.shortName,
      city: university.city,
      state: university.state, // UK: county
      country: university.country ?? 'United Kingdom',
      countryCode: university.countryCode ?? 'GB',
      street: university.street,
      postalCode: university.postalCode,
      phone: university.phone,
      website: university.website,
      registrar: university.registrar,
      emailDomain: university.emailDomain,
      // Note: no stateCode — the UK does not use US-style state abbreviations.
    },
  });
}

export function generateRegistrar(seed) {
  const random = seededRandom(`${seed}:registrar`);
  const female = random() < 0.5;
  // UK registrar offices use a small set of titles; "Academic Registrar" is the
  // senior post, with "Registrar" as a plain alternative.
  const role = pick(random, ['University Registrar', 'Academic Registrar', 'Registrar']);
  return {
    title: pick(random, female ? ['Dr.', 'Ms.', 'Mrs.', 'Miss', ''] : ['Dr.', 'Mr.', '']),
    firstName: pick(random, female ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES),
    lastName: pick(random, LAST_NAMES),
    role,
    female,
  };
}

export { MALE_FIRST_NAMES, FEMALE_FIRST_NAMES, LAST_NAMES, BIRTH_PLACES, STREETS };
