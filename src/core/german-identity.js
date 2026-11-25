import { createHash } from 'node:crypto';

// German identity data used for German university enrolment material.
// Names are drawn from real German name statistics; every composed value is a
// plausible full identity, never a placeholder.
const MALE_FIRST_NAMES = [
  'Alexander', 'Andreas', 'Benjamin', 'Benedikt', 'Christian', 'Christoph', 'Daniel', 'David', 'Dominik',
  'Elias', 'Emil', 'Fabian', 'Felix', 'Finn', 'Florian', 'Franz', 'Frederik', 'Georg', 'Hannes', 'Henrik',
  'Jakob', 'Jan', 'Jonas', 'Jonathan', 'Julian', 'Jürgen', 'Kai', 'Karl', 'Kevin', 'Konstantin', 'Lars',
  'Leon', 'Levin', 'Linus', 'Lukas', 'Malte', 'Marc', 'Marvin', 'Matthias', 'Maximilian', 'Michael',
  'Moritz', 'Nico', 'Niklas', 'Noah', 'Ole', 'Oskar', 'Pascal', 'Patrick', 'Paul', 'Peter', 'Philipp',
  'Rafael', 'Robert', 'Robin', 'Samuel', 'Sebastian', 'Simon', 'Stefan', 'Thomas', 'Tim', 'Tobias',
  'Tristan', 'Valentin', 'Vincent', 'Wolfgang', 'Yannick',
];
const FEMALE_FIRST_NAMES = [
  'Alexandra', 'Alina', 'Amelie', 'Anja', 'Anna', 'Anne', 'Antonia', 'Birgit', 'Carina', 'Carla',
  'Charlotte', 'Christina', 'Clara', 'Claudia', 'Daniela', 'Elisa', 'Elisabeth', 'Emilia', 'Emma',
  'Eva', 'Franziska', 'Frieda', 'Greta', 'Hannah', 'Heike', 'Helena', 'Ida', 'Ines', 'Jana', 'Janina',
  'Johanna', 'Julia', 'Jule', 'Karin', 'Katharina', 'Katrin', 'Klara', 'Kristin', 'Lara', 'Larissa',
  'Laura', 'Lea', 'Lena', 'Leonie', 'Lina', 'Lisa', 'Luisa', 'Magdalena', 'Maike', 'Maja', 'Mareike',
  'Maria', 'Marie', 'Marlene', 'Marta', 'Melanie', 'Merle', 'Mia', 'Miriam', 'Nadine', 'Nele', 'Nina',
  'Paula', 'Pia', 'Rebecca', 'Sabine', 'Sandra', 'Sarah', 'Selina', 'Silke', 'Sophia', 'Sophie',
  'Stefanie', 'Svenja', 'Tabea', 'Tanja', 'Theresa', 'Ulrike', 'Valerie', 'Vanessa', 'Verena', 'Viktoria',
  'Vivian', 'Yvonne', 'Zoe',
];
const LAST_NAMES = [
  'Ahrens', 'Albrecht', 'Auer', 'Bachmann', 'Bauer', 'Baumann', 'Bayer', 'Beck', 'Becker', 'Bender',
  'Bergmann', 'Brandt', 'Braun', 'Brenner', 'Brinkmann', 'Busch', 'Dietrich', 'Dörr', 'Ebert', 'Eckert',
  'Engel', 'Ernst', 'Fischer', 'Frank', 'Franke', 'Frey', 'Friedrich', 'Fuchs', 'Gärtner', 'Geiger',
  'Gerber', 'Graf', 'Groß', 'Günther', 'Haas', 'Hahn', 'Hartmann', 'Hauser', 'Heckmann', 'Heinrich',
  'Heller', 'Herrmann', 'Hoffmann', 'Hofmann', 'Huber', 'Jäger', 'Jansen', 'Jung', 'Kaiser', 'Kappel',
  'Keller', 'Kern', 'Kirchner', 'Klaus', 'Klein', 'Köhler', 'König', 'Kramer', 'Krause', 'Krebs',
  'Krüger', 'Kuhn', 'Kunze', 'Lang', 'Lange', 'Lehmann', 'Lenz', 'Lindner', 'Lorenz', 'Ludwig',
  'Maier', 'Maurer', 'Meier', 'Meister', 'Merkel', 'Meyer', 'Möller', 'Moser', 'Müller', 'Neumann',
  'Nolte', 'Otto', 'Paul', 'Peters', 'Petersen', 'Pfeiffer', 'Pohl', 'Preis', 'Rau', 'Reinhardt',
  'Richter', 'Riedel', 'Ritter', 'Roth', 'Rudolph', 'Sauer', 'Schäfer', 'Scheffler', 'Schindler',
  'Schlüter', 'Schmid', 'Schmidt', 'Schmitt', 'Schneider', 'Scholz', 'Schreiber', 'Schröder', 'Schubert',
  'Schulte', 'Schulz', 'Schulze', 'Schuster', 'Schwarz', 'Seidel', 'Seifert', 'Simon', 'Sommer',
  'Stein', 'Steiner', 'Stoll', 'Thiel', 'Thoma', 'Ulrich', 'Vogel', 'Vogt', 'Voigt', 'Wagner',
  'Walter', 'Weber', 'Wegner', 'Weiß', 'Werner', 'Westphal', 'Winkler', 'Winter', 'Wolf', 'Wolff',
  'Ziegler', 'Zimmermann',
];
const BIRTH_PLACES = [
  'München', 'Berlin', 'Hamburg', 'Köln', 'Frankfurt am Main', 'Stuttgart', 'Düsseldorf', 'Leipzig',
  'Dresden', 'Hannover', 'Nürnberg', 'Bremen', 'Essen', 'Bonn', 'Münster', 'Karlsruhe', 'Mannheim',
  'Augsburg', 'Wiesbaden', 'Kiel', 'Freiburg im Breisgau', 'Erfurt', 'Rostock', 'Mainz', 'Saarbrücken',
  'Potsdam', 'Oldenburg', 'Regensburg', 'Würzburg', 'Ulm',
];
const STREETS = [
  'Lindenstraße', 'Hauptstraße', 'Bahnhofstraße', 'Gartenstraße', 'Schulstraße', 'Ringstraße',
  'Bergstraße', 'Kirchstraße', 'Wiesenweg', 'Am Markt', 'Goethestraße', 'Schillerstraße',
  'Mozartstraße', 'Beethovenstraße', 'Kantstraße', 'Hegelstraße', 'Lessingstraße', 'Uhlandstraße',
  'Nelkenweg', 'Rosenweg', 'Ahornweg', 'Birkenweg', 'Eichenweg', 'Tannenweg', 'Sonnenallee',
  'Stadtgraben', 'Kanalstraße', 'Mühlenweg', 'Feldstraße', 'Parkstraße', 'Nordstraße', 'Südstraße',
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

export function transliterate(value) {
  return value
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '');
}

export function currentSemester(now = new Date()) {
  const month = now.getMonth() + 1;
  // Winter semester: 1 October – 31 March; summer semester: 1 April – 30 September.
  if (month >= 10) {
    return {
      kind: 'WS', label: `Wintersemester ${now.getFullYear()}/${String(now.getFullYear() + 1).slice(2)}`,
      start: `${now.getFullYear()}-10-01`, end: `${now.getFullYear() + 1}-03-31`,
    };
  }
  if (month <= 3) {
    return {
      kind: 'WS', label: `Wintersemester ${now.getFullYear() - 1}/${String(now.getFullYear()).slice(2)}`,
      start: `${now.getFullYear() - 1}-10-01`, end: `${now.getFullYear()}-03-31`,
    };
  }
  return {
    kind: 'SS', label: `Sommersemester ${now.getFullYear()}`,
    start: `${now.getFullYear()}-04-01`, end: `${now.getFullYear()}-09-30`,
  };
}

// Move `back` semesters into the past: WS 2026/27 → SS 2026 → WS 2025/26 → …
export function shiftSemester(semester, back) {
  let year = Number(semester.start.slice(0, 4));
  let kind = semester.kind;
  for (let step = 0; step < back; step++) {
    if (kind === 'WS') { kind = 'SS'; } else { kind = 'WS'; year -= 1; }
  }
  const start = kind === 'WS' ? `${year}-10-01` : `${year}-04-01`;
  const end = kind === 'WS' ? `${year + 1}-03-31` : `${year}-09-30`;
  const label = kind === 'WS'
    ? `Wintersemester ${year}/${String(year + 1).slice(2)}`
    : `Sommersemester ${year}`;
  return { kind, label, start, end };
}

export function germanDate(value) {
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return `${day}.${month}.${year}`;
}

export function generateStudentNumber(university, random) {
  const digits = university.matriculationDigits ?? 7;
  const prefix = university.matriculationPrefix ?? '';
  let body = String(1 + Math.floor(random() * 8));
  while (body.length < digits - prefix.length) body += Math.floor(random() * 10);
  return `${prefix}${body}`;
}

export function generateIdentity(seed, university, { now = new Date() } = {}) {
  const random = seededRandom(seed);
  const female = random() < 0.5;
  const firstName = pick(random, female ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES);
  const middleName = random() < 0.18 ? pick(random, female ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES) : '';
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
  const houseNumber = 1 + Math.floor(random() * 129);
  const postalCode = String(10000 + Math.floor(random() * 89999));
  const semester = currentSemester(now);
  const fachSemester = 1 + Math.floor(random() * 6);
  const enrolledSince = shiftSemester(semester, Math.max(0, fachSemester - 1));
  const emailLocal = `${transliterate(firstName).toLowerCase()}.${transliterate(lastName).toLowerCase()}`;
  const program = pick(random, university.programs ?? ['B.Sc. Informatik']);
  return Object.freeze({
    salutation: female ? 'Frau' : 'Herr',
    firstName,
    middleName,
    lastName,
    fullName: [firstName, middleName, lastName].filter(Boolean).join(' '),
    birthDate,
    birthPlace,
    address: { street: `${street} ${houseNumber}`, postalCode, city: university.city },
    email: `${emailLocal}@${university.emailDomain}`,
    studentNumber: generateStudentNumber(university, random),
    program,
    fachSemester,
    enrolledSince: enrolledSince.label,
    semester,
    university: {
      id: university.id, name: university.name, shortName: university.shortName,
      city: university.city, state: university.state ?? 'Deutschland',
      street: university.street, postalCode: university.postalCode,
      phone: university.phone, website: university.website, secretariat: university.secretariat,
      semesterFee: university.semesterFee ?? '0,00', emailDomain: university.emailDomain,
    },
  });
}

export { MALE_FIRST_NAMES, FEMALE_FIRST_NAMES, LAST_NAMES, BIRTH_PLACES, STREETS };
