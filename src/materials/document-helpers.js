import { createHash } from 'node:crypto';

const PALETTES = [
  { primary: '#1b365d', dark: '#10213b', light: '#f4f6f9', mid: '#e6ebf2', border: '#c4cfdd' },
  { primary: '#7c1d23', dark: '#541216', light: '#faf5f5', mid: '#f2e6e7', border: '#d8bfc2' },
  { primary: '#1b4d3e', dark: '#103127', light: '#f3f7f5', mid: '#e4eee9', border: '#bfd2ca' },
  { primary: '#2c3e50', dark: '#1a252f', light: '#f5f6f8', mid: '#e7eaee', border: '#c6cdd6' },
  { primary: '#1e407c', dark: '#12284f', light: '#f3f6fb', mid: '#e5ebf6', border: '#c1cee5' },
  { primary: '#5c243b', dark: '#3d1626', light: '#f9f4f6', mid: '#efe4e8', border: '#d5bfc8' },
  { primary: '#0f4c5c', dark: '#09303a', light: '#f2f7f8', mid: '#e2ecef', border: '#bdd0d6' },
  { primary: '#374151', dark: '#1f2937', light: '#f6f7f9', mid: '#e9ecef', border: '#cdd2da' },
];

export function themeForUniversity(university) {
  const key = university?.id ?? university?.name ?? 'default';
  const digest = createHash('sha256').update(String(key)).digest();
  const base = PALETTES[digest[0] % PALETTES.length];
  return Object.freeze({
    ...base,
    text: '#111827',
    textDark: '#374151',
    textMuted: '#6b7280',
    white: '#ffffff',
    valid: '#166534',
    headerStyle: digest[1] % 3, // 0: classic centered serif, 1: left institutional, 2: split two-column
  });
}

export function documentReference(identity) {
  const digest = createHash('sha256')
    .update(`${identity.studentNumber}:${identity.issueDate}:${identity.university?.id ?? ''}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  const year = String(identity.issueDate ?? '2026').slice(0, 4);
  return `REG-${year}-${digest}`;
}

const COURSE_POOLS = {
  cs: [
    ['CS 301', 'Data Structures and Algorithms', 4],
    ['CS 340', 'Operating Systems & Concurrency', 4],
    ['CS 362', 'Database Management Systems', 3],
    ['CS 385', 'Computer Networks & Security', 3],
    ['MATH 241', 'Linear Algebra & Matrix Theory', 4],
    ['STAT 220', 'Probability & Statistical Inference', 3],
  ],
  engineering: [
    ['ENG 304', 'Thermodynamics & Heat Transfer', 4],
    ['ENG 318', 'Mechanics of Materials', 3],
    ['ENG 342', 'Signals, Systems & Control', 4],
    ['MATH 252', 'Differential Equations', 4],
    ['PHYS 212', 'Electromagnetism & Optics', 3],
    ['ENG 290', 'Engineering Design Methodology', 3],
  ],
  business: [
    ['ECON 301', 'Intermediate Microeconomics', 3],
    ['FIN 315', 'Corporate Finance & Valuation', 3],
    ['ACCT 240', 'Managerial Accounting', 3],
    ['MGMT 330', 'Operations & Supply Chain', 3],
    ['STAT 215', 'Business Analytics & Econometrics', 4],
    ['MKT 310', 'Consumer Behavior & Strategy', 3],
  ],
  science: [
    ['BIO 302', 'Molecular & Cellular Biology', 4],
    ['CHEM 241', 'Organic Chemistry II', 4],
    ['MATH 225', 'Multivariable Calculus', 4],
    ['PHYS 208', 'Classical & Quantum Mechanics', 3],
    ['BIOC 310', 'Biochemical Pathways', 3],
    ['STAT 230', 'Experimental Design & Analysis', 3],
  ],
  humanities: [
    ['HIST 312', 'Modern European & Atlantic History', 3],
    ['POL 305', 'Comparative Political Institutions', 3],
    ['ENGL 280', 'Academic Rhetoric & Composition', 3],
    ['PHIL 240', 'Ethics & Public Policy', 3],
    ['SOC 260', 'Social Research Methods', 4],
    ['ECON 205', 'Macroeconomic Policy', 3],
  ],
};

const GERMAN_COURSE_POOLS = {
  cs: [
    ['INF-301', 'Algorithmen und Datenstrukturen', 6],
    ['INF-315', 'Datenbanksysteme und SQL', 6],
    ['INF-340', 'Betriebssysteme und Rechnernetze', 6],
    ['MAT-220', 'Lineare Algebra und Numerik', 6],
    ['INF-360', 'Softwaretechnik Praktikum', 6],
  ],
  engineering: [
    ['ING-302', 'Technische Mechanik III', 6],
    ['ING-318', 'Thermodynamik und Strömungslehre', 6],
    ['ING-334', 'Regelungstechnik und Systemdynamik', 6],
    ['MAT-230', 'Höhere Mathematik III', 6],
    ['ING-350', 'Konstruktionslehre und CAD', 6],
  ],
  business: [
    ['BWL-301', 'Unternehmensführung und Controlling', 6],
    ['VWL-310', 'Makroökonomik und Geldpolitik', 6],
    ['BWL-325', 'Investition und Finanzierung', 6],
    ['STAT-210', 'Empirische Wirtschaftsforschung', 6],
    ['RECH-240', 'Handels- und Gesellschaftsrecht', 6],
  ],
  science: [
    ['NAT-301', 'Analytische und Organische Chemie', 6],
    ['NAT-314', 'Statistische Physik und Quantentheorie', 6],
    ['BIO-320', 'Zell- und Molekularbiologie', 6],
    ['MAT-215', 'Analysis III', 6],
    ['NAT-340', 'Experimentelles Laborpraktikum', 6],
  ],
  humanities: [
    ['GES-304', 'Neuere und Neueste Geschichte', 6],
    ['POL-312', 'Politische Systeme im Vergleich', 6],
    ['SOZ-250', 'Methoden der empirischen Sozialforschung', 6],
    ['PHI-230', 'Praktische Philosophie und Ethik', 6],
    ['JUR-210', 'Grundlagen des Öffentlichen Rechts', 6],
  ],
};

function programCategory(program) {
  const lower = String(program || '').toLowerCase();
  if (/computer|informatik|software|data|cyber|artificial|ai\b/.test(lower)) return 'cs';
  if (/engineer|maschinenbau|elektro|mechanical|civil|electrical|aerospace/.test(lower)) return 'engineering';
  if (/business|finance|econom|account|manage|wirtschaft|bwl|vwl|commerce/.test(lower)) return 'business';
  if (/bio|chem|phys|math|neuro|med|psych|natural|science/.test(lower)) return 'science';
  return 'humanities';
}

export function coursesForIdentity(identity, { german = false } = {}) {
  const category = programCategory(identity.program);
  const pools = german ? GERMAN_COURSE_POOLS : COURSE_POOLS;
  const pool = pools[category];
  const digest = createHash('sha256').update(`${identity.studentNumber}:courses`).digest();
  const offset = digest[0] % pool.length;
  const selected = [];
  for (let i = 0; i < 4; i++) {
    const [code, title, credits] = pool[(offset + i) % pool.length];
    selected.push({ code, title, credits });
  }
  return selected;
}

export function portalDomain(university) {
  const site = String(university?.website ?? 'university.edu').replace(/^www\./i, '');
  return `portal.${site}`;
}
