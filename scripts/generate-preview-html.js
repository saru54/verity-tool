import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickUniversity, buildIdentityBundle } from '../src/materials/index.js';
import { germanDate } from '../src/core/german-identity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(__dirname, '..', 'examples');

async function main() {
  const university = await pickUniversity({ universityId: 'tum' });
  const identity = buildIdentityBundle({ seed: 'demo-seed-12345', university });
  const u = identity.university;
  const r = identity.registrar;
  const sigName = `${r.firstName} ${r.lastName}`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  @page { size: 595.28px 841.89px; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica', 'Arial', sans-serif; background: #e6e6e6; display: flex; flex-direction: column; gap: 24px; padding: 24px; }
  .sheet { width: 595.28px; height: 841.89px; background: #fff; position: relative; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.15); }
  .margin { padding: 0 50px; }
  /* Theme */
  :root { --primary: #00694e; --dark: #024230; --mintLight: #f4f8f6; --mintMid: #e8f2ee; --sage: #b8cec6; }
  /* Top bar */
  .topbar { height: 5px; background: var(--primary); margin: 50px 50px 0; }
  /* Header */
  .hdr { padding: 10px 50px 0; display: flex; justify-content: space-between; }
  .hdr-l { flex: 1; }
  .pill { display: inline-block; background: var(--primary); color: #fff; padding: 3px 10px; font-size: 7pt; font-weight: 700; letter-spacing: 0.5px; border-radius: 2px; margin-bottom: 6px; }
  .uni-name { font-size: 13.5pt; font-weight: 700; color: var(--dark); }
  .uni-sec { font-size: 8.5pt; color: #333; margin-top: 2px; }
  .uni-addr { font-size: 8pt; color: #555; margin-top: 1px; }
  .uni-phone { font-size: 8pt; color: #555; margin-top: 1px; }
  .hdr-r { text-align: right; }
  .hdr-r .lbl { font-size: 6.5pt; font-weight: 700; color: var(--primary); }
  .hdr-r .val { font-size: 13pt; font-weight: 700; margin-top: 1px; }
  .hdr-r .date { font-size: 9pt; margin-top: 2px; }
  .hdr-line { margin: 136px 50px 0; height: 2px; background: var(--primary); }
  /* Title */
  .title { padding: 156px 0 0 50px; }
  .title h1 { font-size: 19pt; font-weight: 700; color: #111; }
  .title .sub { font-size: 9pt; font-style: italic; color: #555; margin-top: 3px; }
  /* Info box */
  .info-box { margin: 184px 50px 0; display: flex; background: var(--mintLight); border: 0.6px solid var(--sage); height: 56px; }
  .info-col { flex: 1; padding: 8px 14px; border-right: 0.4px solid var(--sage); }
  .info-col:last-child { border-right: none; }
  .info-lbl { font-size: 6pt; font-weight: 700; color: var(--primary); }
  .info-val { font-size: 10pt; font-weight: 700; margin-top: 3px; }
  .info-sub { font-size: 7.5pt; color: #333; margin-top: 2px; }
  /* Body */
  .body { padding: 252px 50px 0; }
  .body p { font-size: 10pt; color: #333; margin-top: 2px; line-height: 1.4; }
  .body .name { font-size: 13pt; font-weight: 700; color: #111; }
  /* Program banner */
  .banner { margin: 324px 50px 0; background: var(--mintMid); border: 0.5px solid var(--sage); border-left: 3.2px solid var(--primary); height: 20px; display: flex; align-items: center; padding-left: 10px; font-size: 8.5pt; font-weight: 700; color: var(--dark); }
  /* Table */
  .tbl { margin: 354px 50px 0; }
  .tbl-hdr { background: var(--dark); height: 16px; display: flex; align-items: center; color: #fff; font-size: 7pt; font-weight: 700; }
  .tbl-hdr .c1 { width: 140px; padding-left: 8px; }
  .tbl-hdr .c2 { padding-left: 8px; }
  .tbl-row { display: flex; height: 19px; align-items: center; border-bottom: 0.3px solid var(--sage); }
  .tbl-row:nth-child(odd) { background: var(--mintLight); }
  .tbl-row:nth-child(even) { background: #fff; }
  .tbl-row .c1 { width: 140px; padding-left: 8px; font-size: 8.5pt; color: #333; }
  .tbl-row .c2 { padding-left: 8px; font-size: 8.8pt; font-weight: 700; color: #111; }
  /* Note box */
  .note { margin: 538px 50px 0; background: var(--mintLight); border: 0.5px solid var(--sage); border-left: 3.2px solid var(--primary); padding: 10px 12px; }
  .note p { font-size: 8.5pt; color: #333; line-height: 1.5; }
  .note p.muted { font-size: 8pt; color: #555; }
  /* Status banner */
  .status { margin: 610px 50px 0; background: var(--primary); height: 18px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 8pt; font-weight: 700; }
  /* Signature */
  .sig { margin: 660px 50px 0; display: flex; justify-content: space-between; }
  .sig-l { flex: 1; }
  .sig-date { font-size: 9.5pt; color: #333; }
  .sig-hand { font-family: 'Dancing Script', 'Sacramento', cursive; font-size: 22pt; color: var(--dark); margin-top: 4px; transform: rotate(-1.5deg); transform-origin: left; }
  .sig-line { width: 200px; height: 0.6px; background: #444; margin-top: 8px; }
  .sig-name { font-size: 8.8pt; font-weight: 700; margin-top: 6px; }
  .sig-role { font-size: 8.2pt; color: #555; }
  .sig-r { width: 145px; height: 70px; background: var(--mintLight); border: 0.8px solid var(--primary); border-radius: 2px; position: relative; }
  .seal { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 50px; height: 50px; border: 1.2px solid var(--primary); border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 4.5pt; color: var(--primary); font-weight: 700; }
  .seal-inner { border: 0.4px dashed var(--primary); border-radius: 50%; width: 44px; height: 44px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .stamp-text { position: absolute; left: 65px; top: 16px; font-size: 6pt; color: var(--primary); font-weight: 700; }
  .stamp-sub { position: absolute; left: 65px; top: 28px; font-size: 4pt; color: var(--primary); }
  .stamp-org { position: absolute; left: 65px; top: 38px; font-size: 5pt; color: var(--dark); }
  .stamp-date { position: absolute; left: 65px; top: 49px; font-size: 4.5pt; color: #555; }
  /* Footer */
  .footer { position: absolute; bottom: 42px; left: 50px; right: 50px; }
  .footer-line { height: 0.5px; background: var(--sage); margin-bottom: 5px; }
  .footer-text { text-align: center; font-size: 6.8pt; color: #333; }
  .footer-page { text-align: center; font-size: 6.5pt; color: #555; margin-top: 3px; }
  /* Font for signature */
  @import url('https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;700&display=swap');
</style></head>
<body>
<div class="sheet" id="p1">
  <div class="topbar"></div>
  <div class="hdr">
    <div class="hdr-l">
      <div class="pill">OFFICIAL</div>
      <div class="uni-name">${u.name}</div>
      <div class="uni-sec">${u.secretariat}</div>
      <div class="uni-addr">${u.street} · ${u.postalCode} ${u.city}</div>
      <div class="uni-phone">Telefon ${u.phone} · ${u.website}</div>
    </div>
    <div class="hdr-r">
      <div class="lbl">MATRIKELNUMMER</div>
      <div class="val">${identity.studentNumber}</div>
      <div class="lbl">AUSGESTELLT AM</div>
      <div class="date">${germanDate(identity.issueDate)}</div>
    </div>
  </div>
  <div class="hdr-line"></div>
  <div class="title">
    <h1>Immatrikulationsbescheinigung</h1>
    <div class="sub">Certificate of Enrolment</div>
  </div>
  <div class="info-box">
    <div class="info-col">
      <div class="info-lbl">NAME</div>
      <div class="info-val">${identity.fullName}</div>
      <div class="info-sub">geb. ${germanDate(identity.birthDate)} in ${identity.birthPlace}</div>
    </div>
    <div class="info-col">
      <div class="info-lbl">MATRIKELNUMMER</div>
      <div class="info-val">${identity.studentNumber}</div>
      <div class="info-sub">${identity.email}</div>
    </div>
    <div class="info-col">
      <div class="info-lbl">STUDIENGANG</div>
      <div class="info-val">${identity.program}</div>
      <div class="info-sub">${identity.fachSemester}. Fachsemester · ${identity.semester.label}</div>
    </div>
  </div>
  <div class="body">
    <p>Hiermit wird bescheinigt, dass</p>
    <p class="name">${identity.fullName}</p>
    <p>geboren am ${germanDate(identity.birthDate)} in ${identity.birthPlace}, an der ${u.name}</p>
    <p>im Studiengang ${identity.program} unter der Matrikelnummer ${identity.studentNumber} eingeschrieben ist.</p>
    <p>Die Immatrikulation besteht seit dem ${identity.enrolledSince} und umfasst das ${identity.semester.label}.</p>
  </div>
  <div class="banner">Studiengang: ${identity.program} · ${identity.fachSemester}. Fachsemester · ${identity.semester.label}</div>
  <div class="tbl">
    <div class="tbl-hdr"><div class="c1">FELD</div><div class="c2">ANGABE</div></div>
    <div class="tbl-row"><div class="c1">Matrikelnummer</div><div class="c2">${identity.studentNumber}</div></div>
    <div class="tbl-row"><div class="c1">Studiengang</div><div class="c2">${identity.program}</div></div>
    <div class="tbl-row"><div class="c1">Fachsemester</div><div class="c2">${identity.fachSemester}. Fachsemester</div></div>
    <div class="tbl-row"><div class="c1">Immatrikuliert seit</div><div class="c2">${identity.enrolledSince}</div></div>
    <div class="tbl-row"><div class="c1">Aktuelles Semester</div><div class="c2">${identity.semester.label}</div></div>
    <div class="tbl-row"><div class="c1">Studienort</div><div class="c2">${u.city}, ${u.state}</div></div>
    <div class="tbl-row"><div class="c1">Semesterbeitrag</div><div class="c2">${u.semesterFee} EUR (entrichtet)</div></div>
    <div class="tbl-row"><div class="c1">Status</div><div class="c2">ordentlich immatrikuliert</div></div>
  </div>
  <div class="note">
    <p>Der Semesterbeitrag in Höhe von ${u.semesterFee} EUR wurde für das ${identity.semester.label} vollständig entrichtet.</p>
    <p>Die Rückmeldung ist damit abgeschlossen.</p>
    <p class="muted">Diese Bescheinigung ist nur mit Unterschrift und Siegel gültig. Sie dient dem Nachweis des Studierendenstatus gegenüber Behörden, Arbeitgebern, Versicherungen und Hochschulen.</p>
  </div>
  <div class="status">GÜLTIG FÜR DAS ${identity.semester.label.toUpperCase()}</div>
  <div class="sig">
    <div class="sig-l">
      <div class="sig-date">${u.city}, den ${germanDate(identity.issueDate)}</div>
      <div class="sig-hand">${sigName}</div>
      <div class="sig-line"></div>
      <div class="sig-name">${r.title} ${sigName}</div>
      <div class="sig-role">${r.role}</div>
    </div>
    <div class="sig-r">
      <div class="seal"><div class="seal-inner">
        <div>${u.shortName.toUpperCase()}</div>
        <div style="font-size:3pt">STUDIEREN-</div>
        <div style="font-size:3pt">DESSEKR.</div>
        <div style="font-size:3pt">${u.city.toUpperCase()}</div>
      </div></div>
      <div class="stamp-text">${u.shortName.toUpperCase()}</div>
      <div class="stamp-sub">OFFIZIELLES SIEGEL</div>
      <div class="stamp-org">Studierendensekretariat</div>
      <div class="stamp-date">${u.city} · ${germanDate(identity.issueDate)}</div>
    </div>
  </div>
  <div class="footer">
    <div class="footer-line"></div>
    <div class="footer-text">${u.name} · ${u.street} · ${u.postalCode} ${u.city} · ${u.website}</div>
    <div class="footer-page">Matrikelnummer ${identity.studentNumber} · Seite 1 von 1</div>
  </div>
</div>
</body></html>`;

  mkdirSync(outputDir, { recursive: true });
  const htmlPath = resolve(outputDir, 'preview.html');
  writeFileSync(htmlPath, html);
  console.log('HTML preview written to:', htmlPath);
}

main().catch(err => { console.error(err); process.exit(1); });
