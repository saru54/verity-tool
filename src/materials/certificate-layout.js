import { PdfDocument } from './pdf.js';
import { coursesForIdentity, documentReference, portalDomain, themeForUniversity } from './document-helpers.js';

const A4 = { width: 595.28, height: 841.89 };

function letterhead(page, identity, theme, { margin, contentWidth, date }) {
  const u = identity.university;
  const style = theme.headerStyle;

  if (style === 0) {
    // Classic centered academic letterhead
    const cx = margin + contentWidth / 2;
    const nameSize = page.fitText(u.name, contentWidth - 20, { size: 15, minSize: 10, bold: true });
    page.text(u.name.toUpperCase(), cx, 64, { size: nameSize, font: 'serifBold', color: theme.dark, align: 'center' });
    page.text(u.registrar, cx, 79, { size: 9, font: 'serifItalic', color: theme.primary, align: 'center' });
    page.text(`${u.street}, ${u.city}, ${u.state} ${u.postalCode}  |  ${u.phone}  |  ${u.website}`,
      cx, 92, { size: 7.5, font: 'serif', color: theme.textMuted, align: 'center' });
    page.line(margin, 102, page.width - margin, 102, { color: theme.primary, width: 1.4 });
    page.line(margin, 105, page.width - margin, 105, { color: theme.border, width: 0.4 });
    return 124;
  }

  if (style === 1) {
    // Left-aligned institutional header with vertical accent bar
    page.rect(margin, 52, 3.5, 52, { fill: theme.primary, stroke: null });
    const nameSize = page.fitText(u.name, contentWidth - 150, { size: 14, minSize: 9.5, bold: true });
    page.text(u.name, margin + 12, 66, { size: nameSize, font: 'serifBold', color: theme.dark });
    page.text(u.registrar, margin + 12, 80, { size: 8.8, font: 'serif', color: theme.textDark });
    page.text(`${u.street} · ${u.city}, ${u.state} ${u.postalCode}`, margin + 12, 92, { size: 7.8, color: theme.textMuted });
    page.text(`${u.phone} · ${u.website}`, margin + 12, 103, { size: 7.8, color: theme.textMuted });

    const rx = page.width - margin;
    page.text(`Ref: ${documentReference(identity)}`, rx, 66, { size: 7.5, font: 'mono', color: theme.textMuted, align: 'right' });
    page.text(`Date: ${date(identity.issueDate)}`, rx, 80, { size: 8.5, font: 'serif', color: theme.textDark, align: 'right' });
    page.line(margin, 114, page.width - margin, 114, { color: theme.border, width: 0.8 });
    return 132;
  }

  // Style 2: Clean two-column administrative header
  page.rect(margin, 48, contentWidth, 3, { fill: theme.primary, stroke: null });
  const nameSize = page.fitText(u.name, contentWidth - 170, { size: 13.5, minSize: 9, bold: true });
  page.text(u.name, margin, 68, { size: nameSize, font: 'bold', color: theme.dark });
  page.text(u.registrar, margin, 82, { size: 8.5, color: theme.textDark });
  page.text(`${u.street} · ${u.postalCode} ${u.city}, ${u.state}`, margin, 94, { size: 7.8, color: theme.textMuted });
  page.text(`${u.phone} · ${u.website}`, margin, 105, { size: 7.8, color: theme.textMuted });

  const rx = page.width - margin;
  page.text('STUDENT ID', rx, 66, { size: 6.5, font: 'bold', color: theme.primary, align: 'right' });
  page.text(identity.studentNumber, rx, 80, { size: 12, font: 'bold', color: theme.text, align: 'right' });
  page.text(`Issued ${date(identity.issueDate)}`, rx, 95, { size: 8, color: theme.textMuted, align: 'right' });
  page.text(documentReference(identity), rx, 106, { size: 7, font: 'mono', color: theme.textMuted, align: 'right' });
  page.line(margin, 116, page.width - margin, 116, { color: theme.primary, width: 1.2 });
  return 134;
}

function enrollmentTable(page, rows, theme, { top, margin, contentWidth }) {
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

function letterFooter(page, identity, theme, { margin, contentWidth }) {
  const y = page.height - 46;
  page.line(margin, y - 10, page.width - margin, y - 10, { color: theme.border, width: 0.5 });
  const u = identity.university;
  page.text(`${u.name}  ·  ${u.registrar}  ·  ${u.website}`,
    margin + contentWidth / 2, y, { size: 7, font: 'serif', color: theme.textMuted, align: 'center' });
  page.text(`Document Reference ${documentReference(identity)}  ·  Student ID ${identity.studentNumber}`,
    margin + contentWidth / 2, y + 11, { size: 6.5, font: 'mono', color: theme.textMuted, align: 'center' });
}

// Document 1: Formal Registrar Enrollment Verification Letter
export function buildEnrollmentCertificate(identity, locale) {
  const date = locale.date;
  const theme = themeForUniversity(identity.university);
  const document = new PdfDocument({
    ...A4,
    title: `Certificate of Enrollment - ${identity.studentNumber}`,
    author: identity.university.registrar,
    subject: `Enrollment Verification (${identity.semester.label})`,
    issueDate: identity.issueDate,
    seed: `${identity.studentNumber}:enrollment`,
  });
  const page = document.pages[0];
  const margin = 54;
  const contentWidth = page.width - margin * 2;

  let y = letterhead(page, identity, theme, { margin, contentWidth, date });

  page.text('Certificate of Enrollment', margin, y + 14, { size: 17.5, font: 'serifBold', color: theme.dark });
  page.text(`Verification of Student Status · Reference ${documentReference(identity)}`, margin, y + 29, {
    size: 8.8, font: 'serifItalic', color: theme.textMuted,
  });

  y += 52;
  page.text('To Whom It May Concern:', margin, y, { size: 10, font: 'serifBold', color: theme.text });
  y += 20;

  const p1 = `This letter confirms that ${identity.fullName} (Student ID: ${identity.studentNumber}),`;
  const p2 = `born on ${date(identity.birthDate)} in ${identity.birthPlace}, is currently enrolled as a full-time`;
  const p3 = `degree-seeking student at ${identity.university.name} in the ${identity.program} program.`;
  const p4 = `Enrollment has been maintained since ${identity.enrolledSince} and remains active for the ${identity.semester.label} term.`;

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
    ['Student Full Name', identity.fullName],
    ['Student ID', identity.studentNumber],
    ['Date of Birth', date(identity.birthDate)],
    ['Institutional Email', identity.email],
    ['Program of Study', identity.program],
    ['Academic Level', identity.academicYearLabel],
    ['Enrolled Since', identity.enrolledSince],
    ['Active Term', `${identity.semester.label} (${date(identity.semester.start)} - ${date(identity.semester.end)})`],
    ['Campus Location', `${identity.university.city}, ${identity.university.state}`],
    ['Enrollment Status', 'Full-time, actively enrolled (Good Standing)'],
  ];
  const tableBottom = enrollmentTable(page, rows, theme, { top: y, margin, contentWidth });

  let sigY = tableBottom + 24;
  page.text('Please direct any verification inquiries regarding this record to the Office of the Registrar using the',
    margin, sigY, { size: 8.5, font: 'serif', color: theme.textMuted });
  page.text(`contact information listed above and reference ${documentReference(identity)}.`,
    margin, sigY + 12, { size: 8.5, font: 'serif', color: theme.textMuted });

  sigY += 36;
  const registrar = identity.registrar;
  const sigName = `${registrar.firstName} ${registrar.lastName}`;
  page.text(`${identity.university.city}, ${identity.university.state}  —  ${date(identity.issueDate)}`,
    margin, sigY, { size: 9, font: 'serif', color: theme.textDark });
  page.signature(`${identity.studentNumber}:signature`, margin + 4, sigY + 10, 155, 34, {
    name: sigName, color: theme.dark,
  });
  page.line(margin, sigY + 50, margin + 210, sigY + 50, { color: theme.textMuted, width: 0.6 });
  page.text(`${registrar.title} ${registrar.firstName} ${registrar.lastName}`.trim(),
    margin, sigY + 62, { size: 9, font: 'serifBold', color: theme.text });
  page.text(`${registrar.role}, ${identity.university.name}`,
    margin, sigY + 74, { size: 8.2, font: 'serif', color: theme.textMuted });

  letterFooter(page, identity, theme, { margin, contentWidth });
  return document.build();
}

// Document 2: Student Portal Term Registration & Course Schedule Printout
export function buildSemesterCertificate(identity, locale) {
  const date = locale.date;
  const creditsLabel = locale.creditsLabel ?? 'Full-time (14.0 credits)';
  const theme = themeForUniversity(identity.university);
  const u = identity.university;
  const courses = coursesForIdentity(identity, { german: false });
  const totalCredits = courses.reduce((sum, c) => sum + c.credits, 0);

  const document = new PdfDocument({
    ...A4,
    title: `Term Enrollment Verification - ${identity.studentNumber}`,
    author: u.name,
    subject: `Student Portal Schedule (${identity.semester.label})`,
    producer: 'Skia/PDF m130',
    creator: 'Chromium',
    issueDate: identity.issueDate,
    seed: `${identity.studentNumber}:portal`,
  });
  const page = document.pages[0];
  const margin = 46;
  const contentWidth = page.width - margin * 2;

  // Browser print header breadcrumb
  page.text(`https://${portalDomain(u)}/student/enrollment-summary`, margin, 36, {
    size: 7.2, font: 'mono', color: theme.textMuted,
  });
  page.text(`Printed ${date(identity.issueDate)}`, page.width - margin, 36, {
    size: 7.2, font: 'mono', color: theme.textMuted, align: 'right',
  });

  // Portal banner
  page.rect(margin, 48, contentWidth, 44, { fill: theme.primary, stroke: null });
  page.text(`${u.shortName} Student Information System`, margin + 14, 66, {
    size: 12.5, font: 'bold', color: theme.white,
  });
  page.text('Term Enrollment Verification & Registered Course Summary', margin + 14, 81, {
    size: 8.5, color: theme.light,
  });
  page.text(identity.semester.label.toUpperCase(), page.width - margin - 14, 72, {
    size: 9, font: 'bold', color: theme.white, align: 'right',
  });

  // Student account grid
  const infoTop = 104;
  page.rect(margin, infoTop, contentWidth, 68, { fill: theme.light, stroke: theme.border, lineWidth: 0.6 });
  const c1 = margin + 12;
  const c2 = margin + contentWidth * 0.52;

  page.text('STUDENT NAME', c1, infoTop + 14, { size: 6.5, font: 'bold', color: theme.textMuted });
  page.text(identity.fullName, c1, infoTop + 26, { size: 10, font: 'bold', color: theme.text });
  page.text(`Email: ${identity.email}`, c1, infoTop + 40, { size: 8, color: theme.textDark });
  page.text(`Program: ${identity.program}`, c1, infoTop + 54, {
    size: page.fitText(`Program: ${identity.program}`, contentWidth * 0.48, { size: 8, minSize: 6.5 }),
    color: theme.textDark,
  });

  page.text('STUDENT ID', c2, infoTop + 14, { size: 6.5, font: 'bold', color: theme.textMuted });
  page.text(identity.studentNumber, c2, infoTop + 26, { size: 10, font: 'bold', color: theme.text });
  page.text(`Standing: ${identity.academicYearLabel}`, c2, infoTop + 40, { size: 8, color: theme.textDark });
  page.text(`Term Dates: ${date(identity.semester.start)} to ${date(identity.semester.end)}`, c2, infoTop + 54, {
    size: 8, color: theme.textDark,
  });

  // Course registration table
  let y = infoTop + 88;
  page.text('Registered Courses', margin, y, { size: 11, font: 'bold', color: theme.dark });
  page.text(`Total Registered Units: ${totalCredits}.0`, page.width - margin, y, {
    size: 8.5, font: 'bold', color: theme.primary, align: 'right',
  });

  y += 10;
  const headerH = 20;
  const rowH = 22;
  page.rect(margin, y, contentWidth, headerH, { fill: theme.dark, stroke: null });
  page.text('COURSE', margin + 10, y + 13, { size: 7.2, font: 'bold', color: theme.white });
  page.text('COURSE TITLE', margin + 92, y + 13, { size: 7.2, font: 'bold', color: theme.white });
  page.text('CREDITS', margin + 365, y + 13, { size: 7.2, font: 'bold', color: theme.white });
  page.text('STATUS', margin + 430, y + 13, { size: 7.2, font: 'bold', color: theme.white });

  courses.forEach((course, idx) => {
    const ry = y + headerH + idx * rowH;
    page.rect(margin, ry, contentWidth, rowH, {
      fill: idx % 2 === 0 ? theme.white : theme.light,
      stroke: theme.border,
      lineWidth: 0.35,
    });
    page.text(course.code, margin + 10, ry + 14, { size: 8.5, font: 'mono', color: theme.dark });
    page.text(course.title, margin + 92, ry + 14, { size: 8.5, color: theme.text });
    page.text(`${course.credits}.0`, margin + 382, ry + 14, { size: 8.5, color: theme.textDark, align: 'center' });
    page.text('Enrolled', margin + 430, ry + 14, { size: 8.5, font: 'bold', color: theme.valid });
  });

  // Registration & Account Summary box
  y = y + headerH + courses.length * rowH + 22;
  page.text('Enrollment & Account Verification', margin, y, { size: 11, font: 'bold', color: theme.dark });
  y += 10;

  const boxH = 104;
  page.rect(margin, y, contentWidth, boxH, { fill: theme.white, stroke: theme.border, lineWidth: 0.7 });
  const summaryRows = [
    ['Academic Term', identity.semester.label],
    ['Enrollment Load', `${creditsLabel} (${totalCredits}.0 credits registered)`],
    ['Campus', `${u.name} — ${u.city}, ${u.state}`],
    ['Tuition & Fees', 'Assessed & Paid in Full (Balance: 0.00)'],
    ['Registration Status', 'Active — Enrolled (Verified)'],
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
  page.text(`Record generated from ${u.name} Student Information System (${portalDomain(u)}).`,
    margin, noteY + 14, { size: 7.8, color: theme.textMuted });
  page.text(`Verification Reference: ${documentReference(identity)} · Issue Date: ${date(identity.issueDate)}`,
    margin, noteY + 26, { size: 7.8, color: theme.textMuted });
  page.text(`${u.name} · ${u.street} · ${u.city}, ${u.state} ${u.postalCode}`,
    margin, page.height - 36, { size: 7, color: theme.textMuted });

  return document.build();
}
