import { createHash } from 'node:crypto';

// US identity data used for US university enrollment material.
// Names are drawn from real US name statistics; every composed value is a
// plausible full identity, never a placeholder.

const MALE_FIRST_NAMES = [
  'Alexander', 'Andrew', 'Anthony', 'Austin', 'Benjamin', 'Brandon', 'Brian', 'Caleb',
  'Cameron', 'Charles', 'Christian', 'Christopher', 'Connor', 'Daniel', 'David', 'Dominic',
  'Dylan', 'Edward', 'Elijah', 'Ethan', 'Evan', 'Gabriel', 'Gavin', 'George', 'Henry',
  'Hunter', 'Isaac', 'Jack', 'Jacob', 'James', 'Jared', 'Jason', 'John', 'Jonathan',
  'Joseph', 'Joshua', 'Justin', 'Kevin', 'Kyle', 'Liam', 'Logan', 'Lucas', 'Luke',
  'Mark', 'Mason', 'Matthew', 'Michael', 'Nathan', 'Nicholas', 'Noah', 'Oliver',
  'Owen', 'Ryan', 'Samuel', 'Scott', 'Sebastian', 'Stephen', 'Steven', 'Thomas',
  'Timothy', 'Tyler', 'William', 'Zachary',
];
const FEMALE_FIRST_NAMES = [
  'Abigail', 'Addison', 'Alexis', 'Alice', 'Allison', 'Amanda', 'Amber', 'Anna',
  'Arianna', 'Ashley', 'Aubrey', 'Audrey', 'Ava', 'Avery', 'Bailey', 'Bella',
  'Brianna', 'Brooke', 'Camila', 'Caroline', 'Charlotte', 'Chloe', 'Claire', 'Courtney',
  'Crystal', 'Danielle', 'Elizabeth', 'Ella', 'Ellie', 'Emily', 'Emma', 'Erin',
  'Evelyn', 'Faith', 'Grace', 'Hailey', 'Hannah', 'Harper', 'Isabella', 'Jasmine',
  'Jennifer', 'Jessica', 'Julia', 'Kate', 'Kayla', 'Kelsey', 'Kimberly', 'Kyla',
  'Lauren', 'Layla', 'Leah', 'Lila', 'Lily', 'Mackenzie', 'Madison', 'Makayla',
  'Megan', 'Mia', 'Natalie', 'Olivia', 'Paige', 'Peyton', 'Rachel', 'Rebecca',
  'Riley', 'Samantha', 'Sarah', 'Sophia', 'Sophie', 'Stella', 'Sydney', 'Taylor',
  'Victoria', 'Zoe',
];
const LAST_NAMES = [
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
  'Wood', 'Wright', 'Young',
];
const BIRTH_PLACES = [
  'New York, NY', 'Los Angeles, CA', 'Chicago, IL', 'Houston, TX', 'Phoenix, AZ',
  'Philadelphia, PA', 'San Antonio, TX', 'San Diego, CA', 'Dallas, TX', 'San Jose, CA',
  'Austin, TX', 'Jacksonville, FL', 'Columbus, OH', 'Indianapolis, IN', 'Charlotte, NC',
  'Fort Worth, TX', 'Denver, CO', 'Seattle, WA', 'Boston, MA', 'El Paso, TX',
  'Nashville, TN', 'Detroit, MI', 'Portland, OR', 'Memphis, TN', 'Louisville, KY',
  'Baltimore, MD', 'Milwaukee, WI', 'Albuquerque, NM', 'Tucson, AZ', 'Fresno, CA',
  'Sacramento, CA', 'Kansas City, MO', 'Mesa, AZ', 'Atlanta, GA', 'Omaha, NE',
  'Colorado Springs, CO', 'Raleigh, NC', 'Miami, FL', 'Long Beach, CA', 'Virginia Beach, VA',
];
const STREETS = [
  'Main St', 'Oak St', 'Maple St', 'Cedar St', 'Pine St', 'Elm St', 'Washington St',
  'Lake St', 'Hill St', 'Park Ave', 'Church St', 'High St', 'Spring St', 'Forest St',
  'River St', 'Sunset Blvd', 'Lincoln Way', 'Union St', 'Mill St', 'Walnut St',
  'Market St', 'Center St', 'School St', 'Franklin St', 'Liberty St', 'Madison St',
  'Jefferson St', 'Adams St', 'Jackson St', 'Front St', 'Willow Ln', 'Birch Ln',
  'Highland Ave', 'Ridge Ave', 'Country Club Dr', 'Meadow Ln', 'Cherry St',
  'North St', 'South St', 'Broadway',
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

// US universities don't use umlauts, but keep the function for API parity.
export function transliterate(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '');
}

// US academic terms: Fall (Aug–Dec), Spring (Jan–May), Summer (Jun–Jul).
// Most US universities use Fall as the primary enrollment term.
export function currentSemester(now = new Date()) {
  const month = now.getMonth() + 1;
  if (month >= 8) {
    return {
      kind: 'Fall', label: `Fall ${now.getFullYear()}`,
      start: `${now.getFullYear()}-08-25`, end: `${now.getFullYear()}-12-20`,
    };
  }
  if (month <= 5) {
    return {
      kind: 'Spring', label: `Spring ${now.getFullYear()}`,
      start: `${now.getFullYear()}-01-15`, end: `${now.getFullYear()}-05-15`,
    };
  }
  return {
    kind: 'Summer', label: `Summer ${now.getFullYear()}`,
    start: `${now.getFullYear()}-06-01`, end: `${now.getFullYear()}-07-31`,
  };
}

// Move `back` terms into the past: Fall 2026 → Summer 2026 → Spring 2026 → Fall 2025 → …
export function shiftSemester(semester, back) {
  const order = ['Fall', 'Summer', 'Spring'];
  let year = Number(semester.start.slice(0, 4));
  let kind = semester.kind;
  for (let step = 0; step < back; step++) {
    const idx = order.indexOf(kind);
    const nextIdx = (idx + 1) % order.length;
    kind = order[nextIdx];
    if (nextIdx === 0) year -= 1; // wrapped past Fall → previous year
  }
  const start = kind === 'Fall' ? `${year}-08-25` : kind === 'Spring' ? `${year}-01-15` : `${year}-06-01`;
  const end = kind === 'Fall' ? `${year}-12-20` : kind === 'Spring' ? `${year}-05-15` : `${year}-07-31`;
  return { kind, label: `${kind} ${year}`, start, end };
}

// US date format: MM/DD/YYYY
export function usDate(value) {
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return `${month}/${day}/${year}`;
}

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
  const postalCode = String(10000 + Math.floor(random() * 89999));
  const semester = currentSemester(now);
  // US students talk about "academic standing" in years, not Fachsemester.
  const academicYear = 1 + Math.floor(random() * 4); // Freshman(1) – Senior(4)
  const enrolledSince = shiftSemester(semester, Math.max(0, (academicYear - 1) * 3));
  const emailLocal = `${transliterate(firstName).toLowerCase()}.${transliterate(lastName).toLowerCase()}`;
  const program = pick(random, university.programs ?? ['B.S. Computer Science']);
  const academicYearLabel = ['', 'Freshman', 'Sophomore', 'Junior', 'Senior'][academicYear] ?? 'Student';
  return Object.freeze({
    firstName,
    middleName,
    lastName,
    fullName: [firstName, middleName, lastName].filter(Boolean).join(' '),
    birthDate,
    birthPlace,
    address: { street: `${houseNumber} ${street}`, postalCode, city: university.city, state: university.state },
    email: `${emailLocal}@${university.emailDomain}`,
    studentNumber: generateStudentNumber(university, random),
    program,
    academicYear,
    academicYearLabel,
    enrolledSince: enrolledSince.label,
    semester,
    university: {
      id: university.id, name: university.name, shortName: university.shortName,
      city: university.city, state: university.state, stateCode: university.stateCode,
      country: university.country ?? 'United States', countryCode: university.countryCode ?? 'US',
      street: university.street, postalCode: university.postalCode,
      phone: university.phone, website: university.website, registrar: university.registrar,
      emailDomain: university.emailDomain,
    },
  });
}

export function generateRegistrar(seed) {
  const random = seededRandom(`${seed}:registrar`);
  const female = random() < 0.5;
  const titles = female
    ? ['University Registrar']
    : ['University Registrar'];
  // US registrars typically use "Registrar" or "Associate Registrar"
  const role = pick(random, titles);
  return {
    title: pick(random, female ? ['Dr.', 'Ms.', 'Mrs.', ''] : ['Dr.', 'Mr.', '']),
    firstName: pick(random, female ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES),
    lastName: pick(random, LAST_NAMES),
    role,
    female,
  };
}

export { MALE_FIRST_NAMES, FEMALE_FIRST_NAMES, LAST_NAMES, BIRTH_PLACES, STREETS };
