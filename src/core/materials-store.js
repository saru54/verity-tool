import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AutomationError, requireValue } from './errors.js';
import { transliterate as transliterateGerman } from './german-identity.js';
import { transliterate as transliterateUS } from './us-identity.js';
import { transliterate as transliterateCA } from './ca-identity.js';
import { transliterate as transliterateUK } from './uk-identity.js';
import { resolveDynamicProvider, parseProxy } from './proxy.js';
import {
  buildIdentityBundle, buildMaterialFiles, materialSummary, pickUniversity, loadUniversities, MATERIAL_KINDS,
} from '../materials/index.js';
import { formCountryLabel } from '../apps/sheerid/program-profile.js';

const INDEX_FILE = 'material.json';

export function materialsDirectory(artifactsDir) {
  return resolve(artifactsDir, 'materials');
}

export function materialDirectory(artifactsDir, verificationId) {
  requireValue(/^[a-f\d]{24}$/i.test(String(verificationId)), '验证任务 ID 格式无效');
  return join(materialsDirectory(artifactsDir), String(verificationId).toLowerCase());
}

async function writeFileAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, path);
}

function normalizeSummary(summary) {
  requireValue(summary && typeof summary === 'object', '材料索引内容无效');
  requireValue(summary.identity && typeof summary.identity === 'object', '材料索引缺少身份信息');
  requireValue(summary.university && typeof summary.university === 'object', '材料索引缺少学校信息');
  requireValue(Array.isArray(summary.files) && summary.files.length > 0, '材料索引缺少文件清单');
  return summary;
}

export async function readMaterial(artifactsDir, verificationId) {
  const directory = materialDirectory(artifactsDir, verificationId);
  let raw;
  try { raw = await readFile(join(directory, INDEX_FILE), 'utf8'); } catch { return null; }
  try {
    const parsed = JSON.parse(raw);
    return Object.freeze({ ...parsed, summary: normalizeSummary(parsed.summary) });
  } catch {
    throw new AutomationError('MATERIAL_INDEX_INVALID', '材料索引已损坏，请删除该任务的材料目录后重新生成');
  }
}

export async function listMaterials(artifactsDir) {
  const directory = materialsDirectory(artifactsDir);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f\d]{24}$/i.test(entry.name)) continue;
    try {
      const material = await readMaterial(artifactsDir, entry.name);
      if (material) results.push(publicMaterial(entry.name, material));
    } catch { /* skip corrupt entries instead of failing the whole listing */ }
  }
  return results.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

export function publicMaterial(verificationId, material) {
  const attempts = Array.isArray(material.attempts) ? material.attempts : [];
  const task = material.task && typeof material.task === 'object' ? material.task : null;
  const fallbackId = String(verificationId).toLowerCase();
  return {
    verificationId: fallbackId,
    taskId: task?.taskId ?? fallbackId,
    sheeridVerificationId: task?.sheeridVerificationId ?? null,
    url: task?.url ?? material.url ?? null,
    task,
    createdAt: material.createdAt,
    updatedAt: material.updatedAt,
    generated: material.generated !== false,
    university: material.summary.university,
    identity: material.summary.identity,
    files: material.summary.files.map(file => ({ name: file.name, mimeType: file.mimeType, size: file.size, sha256: file.sha256 })),
    attempts: attempts.slice(-10),
    lastStatus: attempts.at(-1)?.status ?? null,
    lastAttemptAt: attempts.at(-1)?.at ?? null,
  };
}

async function persistMaterial(artifactsDir, verificationId, identity, files, { generated = true, existing, url = null, task = null } = {}) {
  const directory = materialDirectory(artifactsDir, verificationId);
  await mkdir(directory, { recursive: true });
  for (const file of files) await writeFileAtomic(join(directory, file.name), file.bytes);
  const now = new Date().toISOString();
  const mergedTask = task
    ? { ...(existing?.task ?? {}), ...task, taskId: task.taskId ?? existing?.task?.taskId ?? String(verificationId).toLowerCase() }
    : (existing?.task ?? null);
  const index = {
    verificationId: String(verificationId).toLowerCase(),
    url: mergedTask?.url ?? url ?? existing?.url ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    generated,
    ...(mergedTask ? { task: mergedTask } : {}),
    summary: materialSummary(identity, files),
    attempts: existing?.attempts ?? [],
  };
  await writeFileAtomic(join(directory, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);
  return Object.freeze(index);
}

// Generate the archived material bundle for one verification task (always fresh; archive only).
export async function ensureMaterials(config, { verificationId, seed, task = null, log = () => {} } = {}) {
  requireValue(/^[a-f\d]{24}$/i.test(String(verificationId)), '验证任务 ID 格式无效');
  const existing = null;
  const materialSeed = seed ?? `${verificationId}:${globalThis.crypto.randomUUID()}`;
  if (existing) {
    const directory = materialDirectory(config.artifactsDir, verificationId);
    const files = [];
    for (const file of existing.summary.files) {
      const bytes = await readFile(join(directory, file.name)).catch(() => null);
      if (bytes) files.push({ name: file.name, mimeType: file.mimeType, bytes });
    }
    if (files.length === existing.summary.files.length) {
      log('material_reused', { stage: 'material', verificationId, university: existing.summary.university.id, files: files.length });
      return { material: existing, identity: existing.summary.identity, files, source: 'reused' };
    }
    log('material_incomplete', { stage: 'material', verificationId, restored: files.length });
  }
  const university = await pickUniversity({
    universityId: config.data?.universityId || config.universityId,
    seed: materialSeed,
    countryCode: config.program?.country ?? config.data?.countryCode ?? 'US',
  });
  // Explicit operator-provided personal data still wins over generated values,
  // so the document always matches the identity that is sent to SheerID.
  const generated = buildIdentityBundle({ seed: materialSeed, university });
  const identity = {
    ...generated,
    university: generated.university,
    registrar: generated.registrar,
  };
  if (config.data?.firstName?.trim()) identity.firstName = config.data.firstName.trim();
  if (config.data?.lastName?.trim()) identity.lastName = config.data.lastName.trim();
  if (config.data?.birthDate?.trim()) identity.birthDate = config.data.birthDate.trim();
  identity.fullName = [identity.firstName, identity.middleName, identity.lastName].filter(Boolean).join(' ');
  // Use the country-appropriate transliterator for the email local part.
  const countryCode = university.countryCode ?? (university.country === 'United States' ? 'US' : 'DE');
  const translit = countryCode === 'US' ? transliterateUS
    : countryCode === 'CA' ? transliterateCA
      : countryCode === 'GB' ? transliterateUK
        : transliterateGerman;
  if (config.data?.firstName?.trim() || config.data?.lastName?.trim()) {
    identity.email = `${translit(identity.firstName).toLowerCase()}.${translit(identity.lastName).toLowerCase()}@${identity.university.emailDomain}`;
  }
  const files = buildMaterialFiles(identity);
  const material = await persistMaterial(config.artifactsDir, verificationId, identity, files, {
    generated: true, existing, url: config.originalUrl ?? config.url, task,
  });
  log('material_generated', {
    stage: 'material', verificationId, university: university.id, studentNumber: identity.studentNumber,
    files: material.summary.files.map(file => file.name),
  });
  return { material, identity: material.summary.identity, files, source: 'generated' };
}

export async function recordMaterialTask(artifactsDir, verificationId, taskPatch = {}) {
  if (!/^[a-f\d]{24}$/i.test(String(verificationId))) return;
  const material = await readMaterial(artifactsDir, verificationId).catch(() => null);
  if (!material) return;
  const task = {
    ...(material.task ?? {}),
    ...taskPatch,
    taskId: taskPatch.taskId ?? material.task?.taskId ?? String(verificationId).toLowerCase(),
  };
  const index = { ...material, url: task.url ?? material.url ?? null, task, updatedAt: new Date().toISOString() };
  delete index.summary;
  const summary = material.summary;
  await writeFileAtomic(join(materialDirectory(artifactsDir, verificationId), INDEX_FILE),
    `${JSON.stringify({ ...index, summary }, null, 2)}\n`);
}

export async function recordMaterialAttempt(artifactsDir, verificationId, attempt) {
  if (!/^[a-f\d]{24}$/i.test(String(verificationId))) return;
  const material = await readMaterial(artifactsDir, verificationId).catch(() => null);
  if (!material) return;
  const previous = Array.isArray(material.attempts) ? material.attempts : [];
  // The document workflow records its own attempt; the queue records the final
  // task outcome. Never store the same run twice.
  if (previous.some(entry => entry.runId === attempt.runId && entry.status === attempt.status
    && entry.code === attempt.code)) return;
  const attempts = [...previous, {
    runId: attempt.runId, at: attempt.at ?? new Date().toISOString(),
    status: attempt.status, code: attempt.code, stage: attempt.stage,
    uploadAttempt: attempt.uploadAttempt, document: attempt.document,
  }].slice(-50);
  const index = { ...material, attempts, updatedAt: new Date().toISOString() };
  delete index.summary;
  const summary = material.summary;
  await writeFileAtomic(join(materialDirectory(artifactsDir, verificationId), INDEX_FILE),
    `${JSON.stringify({ ...index, summary }, null, 2)}\n`);
}

export function resolveMaterialFile(artifactsDir, verificationId, fileName) {
  return { directory: materialDirectory(artifactsDir, verificationId), fileName: String(fileName) };
}

export async function readMaterialFile(artifactsDir, verificationId, fileName) {
  const material = await readMaterial(artifactsDir, verificationId);
  if (!material) throw new AutomationError('MATERIAL_NOT_FOUND', '该任务没有材料存档');
  const entry = material.summary.files.find(file => file.name === fileName);
  if (!entry) throw new AutomationError('MATERIAL_FILE_NOT_FOUND', '材料文件不存在');
  const path = join(materialDirectory(artifactsDir, verificationId), entry.name);
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) throw new AutomationError('MATERIAL_FILE_MISSING', '材料文件已丢失，请重新生成');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== entry.sha256) throw new AutomationError('MATERIAL_FILE_CORRUPT', '材料文件与存档校验值不一致');
  return { entry, bytes };
}

export async function materialExists(artifactsDir, verificationId) {
  return Boolean(await readMaterial(artifactsDir, verificationId).catch(() => null));
}

// One call wires generated material into a run: archives it, fills the identity
// fields the SheerID form needs, and points document upload at the primary PDF.
// An explicitly configured document (path or url) always wins.
function applyBundleToConfig(config, key, bundle) {
  const directory = materialDirectory(config.artifactsDir, key);
  const kind = config.materials?.kind ?? 'enrollment';
  const primaryName = MATERIAL_KINDS[kind] ?? MATERIAL_KINDS.enrollment;
  const primary = bundle.files.find(file => file.name === primaryName) ?? bundle.files[0];
  const documentPath = join(directory, primary.name);
  const explicitDocument = Boolean(config.document?.path?.trim() || config.document?.url?.trim());
  if (!explicitDocument) config.document = { path: documentPath, url: '' };
  const identity = bundle.identity;
  // Derive the form country from the program profile (URL country param), then
  // from the selected countryCode, then fall back to United States for backward
  // compatibility. This keeps the SheerID form country in sync with the
  // university dataset selected by the operator (US/CA/GB/DE).
  const selectedCode = config.program?.country
    ?? identity.university?.countryCode
    ?? config.data?.countryCode
    ?? (config.data?.country === 'United States' ? 'US' : undefined);
  const country = identity.university?.countryCode && identity.university.countryCode === selectedCode
    ? identity.university.country
    : config.data?.country?.trim()
      ? config.data.country.trim()
      : formCountryLabel(config.program, { US: 'United States', CA: 'Canada', GB: 'United Kingdom', DE: 'Germany' }[selectedCode] ?? 'United States');
  config.data = {
    ...config.data,
    firstName: identity.firstName,
    lastName: identity.lastName,
    birthDate: identity.birthDate,
    email: identity.email,
    country,
    ...(selectedCode ? { countryCode: String(selectedCode).toUpperCase() } : {}),
    organization: {
      name: identity.university?.name ?? config.data?.organization?.name,
      optionText: identity.university?.name ?? config.data?.organization?.optionText,
      emailDomain: identity.university?.emailDomain ?? config.data?.organization?.emailDomain,
    },
  };

  // Dynamic proxy (NodeMaven / DataImpulse): if workflow hasn't already selected a
  // verified proxy, build an initial country-targeted proxy matching the university.
  const provider = resolveDynamicProvider(config);
  if (provider && identity.university && !config.proxy) {
    const universityCountry = identity.university.countryCode ?? (identity.university.country === 'United States' ? 'US' : 'DE');
    const sessionId = (`s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`).replace(/[^a-z0-9]/g, '').slice(0, 13);
    const dynamicProxy = provider.build(provider.config, {
      countryCode: universityCountry,
      sessionId,
    });
    config.proxy = parseProxy(dynamicProxy);
  }

  return {
    verificationId: String(key).toLowerCase(),
    source: bundle.source,
    documentPath,
    documentName: primary.name,
    identity,
    material: bundle.material,
    files: bundle.files,
  };
}

export async function findLatestMaterialByVerificationId(artifactsDir, sheeridVerificationId) {
  const target = String(sheeridVerificationId ?? '').toLowerCase();
  if (!/^[a-f\d]{24}$/.test(target)) return null;
  const directory = materialsDirectory(artifactsDir);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return null; }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f\d]{24}$/i.test(entry.name)) continue;
    try {
      const material = await readMaterial(artifactsDir, entry.name);
      if (!material) continue;
      const matchesTarget = material.verificationId === target || material.task?.sheeridVerificationId === target;
      if (matchesTarget) matches.push({ archiveId: entry.name.toLowerCase(), material });
    } catch { /* skip corrupt archives */ }
  }
  matches.sort((left, right) => String(right.material.updatedAt).localeCompare(String(left.material.updatedAt)));
  for (const match of matches) {
    try {
      for (const file of match.material.summary.files) {
        await readMaterialFile(artifactsDir, match.archiveId, file.name);
      }
      return match;
    } catch { /* fall through to older archive or regenerate */ }
  }
  return null;
}

export async function prepareMaterialsForConfig(config, { verificationId, seed, task = null, log = () => {} } = {}) {
  // Key archived materials by each task's unique ID so runs never collide.
  const key = verificationId ?? config.programId;
  const bundle = await ensureMaterials(config, { verificationId: key, seed, task, log });
  return applyBundleToConfig(config, key, bundle);
}

// Reattach previously archived materials for an already-submitted verificationId
// (copying into the new task's own archive directory when taskId differs) so
// every task retains its own independent record while keeping form-matched PDFs.
export async function prepareArchivedMaterialsForConfig(config, {
  verificationId,
  sourceVerificationId = verificationId,
  task = null,
} = {}) {
  const key = verificationId ?? config.programId;
  const sourceKey = sourceVerificationId ?? key;
  const existing = await readMaterial(config.artifactsDir, sourceKey).catch(() => null);
  const summaryFiles = existing?.summary?.files ?? [];
  if (!existing || !summaryFiles.length) return null;
  const loadedFiles = [];
  try {
    for (const file of summaryFiles) {
      const { entry, bytes } = await readMaterialFile(config.artifactsDir, sourceKey, file.name);
      loadedFiles.push({ name: entry.name, mimeType: entry.mimeType, bytes });
    }
  } catch {
    return null;
  }
  if (String(key).toLowerCase() !== String(sourceKey).toLowerCase()) {
    const clonedTask = {
      ...(existing.task ?? {}),
      ...(task ?? {}),
      taskId: String(key).toLowerCase(),
      sheeridVerificationId: task?.sheeridVerificationId ?? existing.task?.sheeridVerificationId ?? String(sourceKey).toLowerCase(),
      archivedFromTaskId: String(sourceKey).toLowerCase(),
    };
    const cloned = await persistMaterial(config.artifactsDir, key, existing.summary.identity, loadedFiles, {
      generated: true,
      url: clonedTask.url ?? existing.url,
      task: clonedTask,
    });
    return applyBundleToConfig(config, key, {
      material: cloned,
      identity: cloned.summary.identity,
      files: cloned.summary.files,
      source: 'archived',
    });
  }
  return applyBundleToConfig(config, key, {
    material: existing,
    identity: existing.summary.identity,
    files: summaryFiles,
    source: 'archived',
  });
}

export { INDEX_FILE, loadUniversities, MATERIAL_KINDS };
