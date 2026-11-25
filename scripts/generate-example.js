import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickUniversity, buildIdentityBundle, buildMaterialFiles, materialSummary } from '../src/materials/index.js';
import { preloadFonts } from '../src/materials/signature.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(__dirname, '..', 'examples');

async function main() {
  preloadFonts();
  const university = await pickUniversity({ universityId: 'tum' });
  const identity = buildIdentityBundle({ seed: 'demo-seed-12345', university });
  const files = buildMaterialFiles(identity);

  mkdirSync(outputDir, { recursive: true });
  for (const file of files) {
    const path = resolve(outputDir, file.name);
    writeFileSync(path, file.bytes);
    console.log(`Generated: ${path} (${file.bytes.length} bytes)`);
  }

  const summary = materialSummary(identity, files);
  console.log('\n=== Identity Summary ===');
  console.log(`  Name:           ${summary.identity.fullName}`);
  console.log(`  University:     ${summary.university.name}`);
  console.log(`  Program:        ${summary.identity.program}`);
  console.log(`  Student Number: ${summary.identity.studentNumber}`);
  console.log(`  Semester:       ${summary.identity.semester.label}`);
  console.log(`  Fachsemester:   ${summary.identity.fachSemester}`);
  console.log(`  Registrar:      ${summary.identity.registrar.title} ${summary.identity.registrar.firstName} ${summary.identity.registrar.lastName}`);
  console.log(`  Files:          ${summary.files.map(f => `${f.name} (${f.size} bytes)`).join(', ')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
