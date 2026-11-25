import { createHash } from 'node:crypto';
import { PdfDocument } from './pdf.js';
import { FEMALE_FIRST_NAMES, MALE_FIRST_NAMES, LAST_NAMES, germanDate } from '../core/german-identity.js';
import { coursesForIdentity, documentReference, portalDomain, themeForUniversity } from './document-helpers.js';

const A4 = { width: 595.28, height: 841.89 };

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
  const female = random() < 0.55;
  const titles = female
    ? ['Dr. rer. nat.', 'Dr. jur.', 'Dipl.-Verwaltungswirtin (FH)', 'M.A.', 'Dr. phil.']
    : ['Dr. rer. nat.', 'Dr. jur.', 'Dipl.-Verwaltungswirt (FH)', 'M.A.', 'Dr. phil.'];
  const role = female ? 'Leiterin des Studierendensekretariats' : 'Leiter des Studierendensekretariats';
  return {
    title: pick(random, titles),
    firstName: pick(random, female ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES),
    lastName: pick(random, LAST_NAMES),
    role,
    female,
  };
}

function germanLetterhead(page, identity, theme, { margin, contentWidth }) {
  const u = identity.university;
  const style = theme.headerStyle;

  if (style === 0) {
    const cx = margin + contentWidth / 2;
    const nameSize = page.fitText(u.name, contentWidth - 20, { size: 15, minSize: 10, bold: true });
    page.text(u.name.toUpperCase(), cx, 64, { size: nameSize, font: 'serifBold', color: theme.dark, align: 'center' });
    page.text(u.secretariat, cx, 79, { size: 9, font: 'serifItalic', color: theme.primary, align: 'center' });
    page.text(`${u.street} · ${u.postalCode} ${u.city} · Tel. ${u.phone} · ${u.website}`,
      cx, 92, { size: 7.5, font: 'serif', color: theme.textMuted, align: 'center' });
    page.line(margin, 102, page.width - margin, 102, { color: theme.primary, width: 1.4 });
    page.line(margin, 105, page.width - margin, 105, { color: theme.border, width: 0.4 });
    return 124;
  }

  if (style === 1) {
    page.rect(margin, 52, 3.5, 52, { fill: theme.primary, stroke: null });
    const nameSize = page.fitText(u.name, contentWidth - 150, { size: 14, minSize: 9.5, bold: true });
    page.text(u.name, margin + 12, 66, { size: nameSize, font: 'serifBold', color: theme.dark });
    page.text(u.secretariat, margin + 12, 80, { size: 8.8, font: 'serif', color: theme.textDark });
    page.text(`${u.street} · ${u.postalCode} ${u.city}`, margin + 12, 92, { size: 7.8, color: theme.textMuted });
    page.text(`Tel. ${u.phone} · ${u.website}`, margin + 12, 103, { size: 7.8, color: theme.textMuted });

    const rx = page.width - margin;
    page.text(`Az.: ${documentReference(identity)}`, rx, 66, { size: 7.5, font: 'mono', color: theme.textMuted, align: 'right' });
    page.text(`Datum: ${germanDate(identity.issueDate)}`, rx, 80, { size: 8.5, font: 'serif', color: theme.textDark, align: 'right' });
    page.line(margin, 114, page.width - margin, 114, { color: theme.border, width: 0.8 });
    return 132;
  }

  page.rect(margin, 48, contentWidth, 3, { fill: theme.primary, stroke: null });
  const nameSize = page.fitText(u.name, contentWidth - 170, { size: 13.5, minSize: 9, bold: true });
  page.text(u.name, margin, 68, { size: nameSize, font: 'bold', color: theme.dark });
  page.text(u.secretariat, margin, 82, { size: 8.5, color: theme.textDark });
  page.text(`${u.street} · ${u.postalCode} ${u.city}`, margin, 94, { size: 7.8, color: theme.textMuted });
  page.text(`Tel. ${u.phone} · ${u.website}`, margin, 105, { size: 7.8, color: theme.textMuted });

  const rx = page.width - margin;
  page.text('MATRIKELNUMMER', rx, 66, { size: 6.5, font: 'bold', color: theme.primary, align: 'right' });
  page.text(identity.studentNumber, rx, 80, { size: 12, font: 'bold', color: theme.text, align: 'right' });
  page.text(`Ausgestellt: ${germanDate(identity.issueDate)}`, rx, 95, { size: 8, color: theme.textMuted, align: 'right' });
  page.text(documentReference(identity), rx, 106, { size: 7, font: 'mono', color: theme.textMuted, align: 'right' });
  page.line(margin, 116, page.width - margin, 116, { color: theme.primary, width: 1.2 });
  return 134;
}

function germanTable(page, rows, theme, { top, margin, contentWidth }) {
  const col1W = 155;
  const rowH = 20;
  page.line(margin, top, page.width - margin, top, { color: theme.primary, width: 0.9 });
  rows.forEach(([label, value], index) => {
    const y = top + index * rowH;
    if (index % 2 === 0) {
      page.rect(margin, y, contentWidth, rowH, { fill: theme.light, stroke: null });
    }
    page.line(margin, y + rowH, page.width - margin, y + rowH, { color: theme.border, width: 0.35 });
    page.text(label, margin + 8, y + 13.5, { size: 8.8, font: 'serif', color: theme.textMuted });
    page.text(value, margin + col1W + 8, y + 13.5, {
      size: page.fitText(value, contentWidth - col1W - 16, { size: 9.2, minSize: 7, bold: true }),
      font: 'serifBold',
      color: theme.text,
    });
  });
  return top + rows.length * rowH;
}

function germanFooter(page, identity, theme, { margin, contentWidth }) {
  const y = page.height - 46;
  page.line(margin, y - 10, page.width - margin, y - 10, { color: theme.border, width: 0.5 });
  const u = identity.university;
  page.text(`${u.name}  ·  ${u.secretariat}  ·  ${u.website}`,
    margin + contentWidth / 2, y, { size: 7, font: 'serif', color: theme.textMuted, align: 'center' });
  page.text(`Aktenzeichen ${documentReference(identity)}  ·  Matrikelnummer ${identity.studentNumber}`,
    margin + contentWidth / 2, y + 11, { size: 6.5, font: 'mono', color: theme.textMuted, align: 'center' });
}

// Document 1: Amtliche Immatrikulationsbescheinigung
export function buildEnrollmentCertificate(identity) {
  const theme = themeForUniversity(identity.university);
  const document = new PdfDocument({
    ...A4,
    title: `Immatrikulationsbescheinigung - ${identity.studentNumber}`,
    author: identity.university.secretariat,
    subject: `Immatrikulationsbescheinigung (${identity.semester.label})`,
    issueDate: identity.issueDate,
    seed: `${identity.studentNumber}:de-enrollment`,
  });
  const page = document.pages[0];
  const margin = 54;
  const contentWidth = page.width - margin * 2;

  let y = germanLetterhead(page, identity, theme, { margin, contentWidth });

  page.text('Immatrikulationsbescheinigung', margin, y + 14, { size: 17.5, font: 'serifBold', color: theme.dark });
  page.text(`Bescheinigung nach § 9 HRG · Aktenzeichen ${documentReference(identity)}`, margin, y + 29, {
    size: 8.8, font: 'serifItalic', color: theme.textMuted,
  });

  y += 52;
  page.text('Amtliche Bestätigung der Einschreibung', margin, y, { size: 10, font: 'serifBold', color: theme.text });
  y += 20;

  const p1 = `Hiermit wird bescheinigt, dass ${identity.salutation} ${identity.fullName} (Matrikelnummer ${identity.studentNumber}),`;
  const p2 = `geboren am ${germanDate(identity.birthDate)} in ${identity.birthPlace}, an der ${identity.university.name}`;
  const p3 = `im Studiengang ${identity.program} (${identity.fachSemester}. Fachsemester) ordentlich eingeschrieben ist.`;
  const p4 = `Die Einschreibung besteht seit dem ${identity.enrolledSince} und gilt für das ${identity.semester.label}.`;

  for (const line of [p1, p2, p3, p4]) {
    page.text(line, margin, y, {
      size: page.fitText(line, contentWidth, { size: 10, minSize: 8 }),
      font: 'serif',
      color: theme.textDark,
    });
    y += 15;
  }

  y += 12;
  const rows = [
    ['Name', identity.fullName],
    ['Matrikelnummer', identity.studentNumber],
    ['Geburtsdatum', germanDate(identity.birthDate)],
    ['Hochschul-E-Mail', identity.email],
    ['Studiengang', identity.program],
    ['Fachsemester', `${identity.fachSemester}. Fachsemester`],
    ['Immatrikuliert seit', identity.enrolledSince],
    ['Gültigkeitszeitraum', `${identity.semester.label} (${germanDate(identity.semester.start)} - ${germanDate(identity.semester.end)})`],
    ['Studienort', `${identity.university.city}, ${identity.university.state ?? 'Deutschland'}`],
    ['Studienstatus', 'Ordentlich immatrikuliert (Vollzeitstudium)'],
  ];
  const tableBottom = germanTable(page, rows, theme, { top: y, margin, contentWidth });

  let sigY = tableBottom + 24;
  page.text(`Der Semesterbeitrag für das ${identity.semester.label} in Höhe von ${identity.university.semesterFee} EUR wurde vollständig entrichtet.`,
    margin, sigY, { size: 8.5, font: 'serif', color: theme.textMuted });
  page.text('Diese Bescheinigung dient als Nachweis des Studierendenstatus gegenüber Behörden und Institutionen.',
    margin, sigY + 12, { size: 8.5, font: 'serif', color: theme.textMuted });

  sigY += 36;
  const registrar = identity.registrar;
  const sigName = `${registrar.firstName} ${registrar.lastName}`;
  page.text(`${identity.university.city}, den ${germanDate(identity.issueDate)}`,
    margin, sigY, { size: 9, font: 'serif', color: theme.textDark });
  page.signature(`${identity.studentNumber}:signature`, margin + 4, sigY + 10, 155, 34, {
    name: sigName, color: theme.dark,
  });
  page.line(margin, sigY + 50, margin + 210, sigY + 50, { color: theme.textMuted, width: 0.6 });
  page.text(`${registrar.title} ${registrar.firstName} ${registrar.lastName}`.trim(),
    margin, sigY + 62, { size: 9, font: 'serifBold', color: theme.text });
  page.text(`${registrar.role}, ${identity.university.name}`,
    margin, sigY + 74, { size: 8.2, font: 'serif', color: theme.textMuted });

  germanFooter(page, identity, theme, { margin, contentWidth });
  return document.build();
}

// Document 2: Studierendenportal — Semesterbescheinigung & Kursübersicht
export function buildSemesterCertificate(identity) {
  const theme = themeForUniversity(identity.university);
  const u = identity.university;
  const courses = coursesForIdentity(identity, { german: true });
  const totalEcts = courses.reduce((sum, c) => sum + c.credits, 0);

  const document = new PdfDocument({
    ...A4,
    title: `Semesterbescheinigung - ${identity.studentNumber}`,
    author: u.name,
    subject: `Studierendenportal Rückmeldung (${identity.semester.label})`,
    producer: 'Skia/PDF m130',
    creator: 'Chromium',
    issueDate: identity.issueDate,
    seed: `${identity.studentNumber}:de-portal`,
  });
  const page = document.pages[0];
  const margin = 46;
  const contentWidth = page.width - margin * 2;

  page.text(`https://${portalDomain(u)}/campus/semesterbescheinigung`, margin, 36, {
    size: 7.2, font: 'mono', color: theme.textMuted,
  });
  page.text(`Stand: ${germanDate(identity.issueDate)}`, page.width - margin, 36, {
    size: 7.2, font: 'mono', color: theme.textMuted, align: 'right',
  });

  page.rect(margin, 48, contentWidth, 44, { fill: theme.primary, stroke: null });
  page.text(`${u.shortName} Studierendenportal`, margin + 14, 66, {
    size: 12.5, font: 'bold', color: theme.white,
  });
  page.text('Semesterbescheinigung · Belegte Module & Beitragsnachweis', margin + 14, 81, {
    size: 8.5, color: theme.light,
  });
  page.text(identity.semester.label.toUpperCase(), page.width - margin - 14, 72, {
    size: 8.5, font: 'bold', color: theme.white, align: 'right',
  });

  const infoTop = 104;
  page.rect(margin, infoTop, contentWidth, 68, { fill: theme.light, stroke: theme.border, lineWidth: 0.6 });
  const c1 = margin + 12;
  const c2 = margin + contentWidth * 0.52;

  page.text('STUDIERENDE / STUDIERENDER', c1, infoTop + 14, { size: 6.5, font: 'bold', color: theme.textMuted });
  page.text(identity.fullName, c1, infoTop + 26, { size: 10, font: 'bold', color: theme.text });
  page.text(`E-Mail: ${identity.email}`, c1, infoTop + 40, { size: 8, color: theme.textDark });
  page.text(`Studiengang: ${identity.program}`, c1, infoTop + 54, {
    size: page.fitText(`Studiengang: ${identity.program}`, contentWidth * 0.48, { size: 8, minSize: 6.5 }),
    color: theme.textDark,
  });

  page.text('MATRIKELNUMMER', c2, infoTop + 14, { size: 6.5, font: 'bold', color: theme.textMuted });
  page.text(identity.studentNumber, c2, infoTop + 26, { size: 10, font: 'bold', color: theme.text });
  page.text(`Fachsemester: ${identity.fachSemester}. Fachsemester`, c2, infoTop + 40, { size: 8, color: theme.textDark });
  page.text(`Semesterzeitraum: ${germanDate(identity.semester.start)} - ${germanDate(identity.semester.end)}`, c2, infoTop + 54, {
    size: 8, color: theme.textDark,
  });

  let y = infoTop + 88;
  page.text('Belegte Lehrveranstaltungen im aktuellen Semester', margin, y, { size: 11, font: 'bold', color: theme.dark });
  page.text(`Summe: ${totalEcts} ECTS`, page.width - margin, y, {
    size: 8.5, font: 'bold', color: theme.primary, align: 'right',
  });

  y += 10;
  const headerH = 20;
  const rowH = 22;
  page.rect(margin, y, contentWidth, headerH, { fill: theme.dark, stroke: null });
  page.text('MODUL-NR.', margin + 10, y + 13, { size: 7.2, font: 'bold', color: theme.white });
  page.text('LEHRVERANSTALTUNG', margin + 92, y + 13, { size: 7.2, font: 'bold', color: theme.white });
  page.text('ECTS', margin + 365, y + 13, { size: 7.2, font: 'bold', color: theme.white });
  page.text('STATUS', margin + 425, y + 13, { size: 7.2, font: 'bold', color: theme.white });

  courses.forEach((course, idx) => {
    const ry = y + headerH + idx * rowH;
    page.rect(margin, ry, contentWidth, rowH, {
      fill: idx % 2 === 0 ? theme.white : theme.light,
      stroke: theme.border,
      lineWidth: 0.35,
    });
    page.text(course.code, margin + 10, ry + 14, { size: 8.5, font: 'mono', color: theme.dark });
    page.text(course.title, margin + 92, ry + 14, { size: 8.5, color: theme.text });
    page.text(`${course.credits}`, margin + 375, ry + 14, { size: 8.5, color: theme.textDark, align: 'center' });
    page.text('Angemeldet', margin + 425, ry + 14, { size: 8.5, font: 'bold', color: theme.valid });
  });

  y = y + headerH + courses.length * rowH + 22;
  page.text('Rückmeldung & Zahlungsnachweis Semesterbeitrag', margin, y, { size: 11, font: 'bold', color: theme.dark });
  y += 10;

  const boxH = 104;
  page.rect(margin, y, contentWidth, boxH, { fill: theme.white, stroke: theme.border, lineWidth: 0.7 });
  const summaryRows = [
    ['Semester', identity.semester.label],
    ['Semesterbeitrag', `${u.semesterFee} EUR`],
    ['Verwendungszweck', `${identity.studentNumber} / ${identity.semester.label}`],
    ['Buchungsdatum', germanDate(identity.semester.start)],
    ['Zahlungsstatus', 'Bezahlt und verbucht (Rückmeldung abgeschlossen)'],
  ];
  summaryRows.forEach(([k, v], i) => {
    const ry = y + 18 + i * 19;
    page.text(k, margin + 12, ry, { size: 8.5, color: theme.textMuted });
    page.text(v, margin + 150, ry, {
      size: 8.8,
      font: i === 4 ? 'bold' : 'regular',
      color: i === 4 ? theme.valid : theme.text,
    });
  });

  const noteY = y + boxH + 22;
  page.line(margin, noteY, page.width - margin, noteY, { color: theme.border, width: 0.5 });
  page.text(`Elektronisch erstellt über das Campus-Portal der ${u.name} (${portalDomain(u)}).`,
    margin, noteY + 14, { size: 7.8, color: theme.textMuted });
  page.text(`Prüfnummer: ${documentReference(identity)} · Ausstellungsdatum: ${germanDate(identity.issueDate)}`,
    margin, noteY + 26, { size: 7.8, color: theme.textMuted });
  page.text(`${u.name} · ${u.street} · ${u.postalCode} ${u.city}`,
    margin, page.height - 36, { size: 7, color: theme.textMuted });

  return document.build();
}
