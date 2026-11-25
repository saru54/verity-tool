import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir, rename, readFile } from 'node:fs/promises';
import { normalizeConfig, normalizeWebConfig, checkKeys } from '../core/config.js';
import { resolveDynamicProvider, normalizeNodeMavenConfig, normalizeDataImpulseConfig } from '../core/proxy.js';
import { ensureWebConfigFile } from '../core/web-config-file.js';
import { AutomationError, requireValue } from '../core/errors.js';
import { withLogSink } from '../core/logger.js';
import { runWorkflow } from '../core/workflow.js';
import { verificationIdFromUrl } from '../apps/sheerid/client.js';
import { PROFILE_KEYS } from '../apps/sheerid/profiles/index.js';
import {
  prepareMaterialsForConfig, listMaterials, materialExists, publicMaterial, readMaterial, readMaterialFile, recordMaterialAttempt, recordMaterialTask,
} from '../core/materials-store.js';

export const DEDUPLICATED = Symbol('deduplicated');

export class WebJobs {
  constructor({ configFile = resolve('config/sheerid.local.json'), workflow = runWorkflow, exampleFile } = {}) {
    this.configFile = configFile;
    this.exampleFile = exampleFile;
    this.workflow = workflow;
    this.jobs = new Map();
    this.queue = [];
    this.running = new Set();
    this.concurrency = 1;
    this.admissions = Promise.resolve();
    this.pendingWrites = new Set();
    this.closing = false;
    this.draining = false;
  }

  async readConfig() {
    const { raw } = await ensureWebConfigFile(this.configFile, this.exampleFile ? { exampleFile: this.exampleFile } : {});
    return raw;
  }

  // Dynamic proxy providers (NodeMaven / DataImpulse) + default provider selection.
  async readProxySettings() {
    const raw = await this.readConfig();
    return {
      proxyProvider: raw.proxyProvider ?? 'nodemaven',
      nodemaven: raw.nodemaven ?? null,
      dataimpulse: raw.dataimpulse ?? null,
      hasStaticProxy: Boolean(raw.proxy && raw.proxy !== 'direct'),
    };
  }

  async saveProxySettings(body) {
    checkKeys(body, ['proxyProvider', 'nodemaven', 'dataimpulse'], '代理设置');
    const text = await readFile(this.configFile, 'utf8');
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));

    if ('proxyProvider' in body) {
      if (body.proxyProvider === null || body.proxyProvider === '') {
        delete parsed.proxyProvider;
      } else {
        requireValue(typeof body.proxyProvider === 'string', 'proxyProvider 必须是字符串');
        const nextProvider = body.proxyProvider.trim().toLowerCase();
        requireValue(['nodemaven', 'dataimpulse', 'direct'].includes(nextProvider),
          'proxyProvider 仅支持 nodemaven、dataimpulse 或 direct');
        parsed.proxyProvider = nextProvider;
      }
    }

    if ('nodemaven' in body) {
      if (body.nodemaven === null) {
        delete parsed.nodemaven;
      } else {
        const nm = normalizeNodeMavenConfig(body.nodemaven);
        if (!nm) delete parsed.nodemaven;
        else parsed.nodemaven = { host: nm.host, port: nm.port, username: nm.username, password: nm.password, filter: nm.filter, ipv4Only: nm.ipv4Only };
      }
    }

    if ('dataimpulse' in body) {
      if (body.dataimpulse === null) {
        delete parsed.dataimpulse;
      } else {
        const di = normalizeDataImpulseConfig(body.dataimpulse);
        if (!di) delete parsed.dataimpulse;
        else parsed.dataimpulse = { host: di.host, port: di.port, username: di.username, password: di.password };
      }
    }

    await writeFile(this.configFile, `${JSON.stringify(parsed, null, 2)}\n`);
    return {
      proxyProvider: parsed.proxyProvider ?? 'nodemaven',
      nodemaven: parsed.nodemaven ?? null,
      dataimpulse: parsed.dataimpulse ?? null,
      hasStaticProxy: Boolean(parsed.proxy && parsed.proxy !== 'direct'),
    };
  }

  // DataImpulse residential proxy credentials (host/port/username/password).
  async readDataImpulse() {
    const raw = await this.readConfig();
    return { dataimpulse: raw.dataimpulse ?? null };
  }
  async saveDataImpulse(value) {
    requireValue(value === null || typeof value === 'object', 'DataImpulse 配置必须是对象或 null');
    const { readFile, writeFile } = await import('node:fs/promises');
    const text = await readFile(this.configFile, 'utf8');
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (value === null) {
      delete parsed.dataimpulse;
    } else {
      parsed.dataimpulse = {
        host: typeof value.host === 'string' && value.host.trim() ? value.host.trim() : 'gw.dataimpulse.com',
        port: Number.isInteger(value.port) ? value.port : 10000,
        username: typeof value.username === 'string' ? value.username.trim() : '',
        password: typeof value.password === 'string' ? value.password : '',
      };
    }
    await writeFile(this.configFile, `${JSON.stringify(parsed, null, 2)}\n`);
    return { dataimpulse: parsed.dataimpulse ?? null };
  }

  async initialize() {
    const { raw, created } = await ensureWebConfigFile(this.configFile, this.exampleFile ? { exampleFile: this.exampleFile } : {});
    this.configCreated = created;
    this.concurrency = normalizeWebConfig(raw?.web).concurrency;
    this.artifactsDir = resolve(raw?.artifactsDir ?? '.runs');
  }

  // Archived material per verificationId. Every task keeps its own folder so a
  // second review round can re-upload the exact same documents.
  async listMaterials() {
    const artifactsDir = this.artifactsDir ?? resolve('.runs');
    return { materials: await listMaterials(artifactsDir) };
  }

  async getMaterial(id) {
    const artifactsDir = this.artifactsDir ?? resolve('.runs');
    requireValue(/^[a-f\d]{24}$/i.test(String(id)), '任务 ID 格式无效');
    const material = await readMaterial(artifactsDir, id);
    if (!material) throw new AutomationError('MATERIAL_NOT_FOUND', '该任务没有材料存档');
    return publicMaterial(id, material);
  }

  async getMaterialFile(id, name) {
    const artifactsDir = this.artifactsDir ?? resolve('.runs');
    return readMaterialFile(artifactsDir, id, name);
  }

  start(input) {
    // Serialize admission only, not execution: preserve FIFO and deduplicate even
    // when concurrent HTTP requests are awaiting disk reads or validation.
    const admission = this.admissions.then(() => this.enqueue(input));
    this.admissions = admission.catch(() => {});
    return admission;
  }

  async enqueue(input) {
    if (this.closing) throw new AutomationError('SERVER_STOPPING', '服务正在关闭');
    checkKeys(input, ['url', 'profile', 'proxyProvider', 'firstName', 'lastName', 'birthDate', 'universityId', 'countryCode', 'fillOnly', 'keepOpenOnFailure'], '表单');
    requireValue(typeof input.url === 'string' && input.url.trim().length > 0, '请填写 url');
    requireValue(input.profile === undefined || (typeof input.profile === 'string' && PROFILE_KEYS.includes(input.profile)),
      `网站类型无效，可选：${PROFILE_KEYS.join(', ')}`);
    const requestedProvider = input.proxyProvider === undefined || input.proxyProvider === null || String(input.proxyProvider).trim() === ''
      ? undefined
      : (requireValue(typeof input.proxyProvider === 'string', 'proxyProvider 必须是字符串'), input.proxyProvider.trim().toLowerCase());
    if (requestedProvider !== undefined) {
      requireValue(['nodemaven', 'dataimpulse', 'direct'].includes(requestedProvider),
        'proxyProvider 仅支持 nodemaven、dataimpulse 或 direct');
    }
    for (const key of ['firstName', 'lastName', 'birthDate']) {
      requireValue(input[key] === undefined || (typeof input[key] === 'string'), `${key} 必须是字符串`);
    }
    requireValue(input.birthDate === undefined || input.birthDate.trim() === ''
      || /^\d{4}-\d{2}-\d{2}$/.test(input.birthDate.trim()), 'birthDate 必须是 YYYY-MM-DD');
    if (input.birthDate?.trim()) {
      const timestamp = Date.parse(`${input.birthDate.trim()}T00:00:00Z`);
      requireValue(Number.isFinite(timestamp)
        && new Date(timestamp).toISOString().slice(0, 10) === input.birthDate.trim()
        && timestamp < Date.now(), 'birthDate 不是有效的出生日期');
    }
    requireValue(input.universityId === undefined || (typeof input.universityId === 'string' && /^[a-z0-9-]+$/.test(input.universityId)),
      'universityId 格式无效');
    requireValue(input.countryCode === undefined || (typeof input.countryCode === 'string' && /^(US|CA|GB|DE)$/i.test(input.countryCode)),
      'countryCode 仅支持 US、CA、GB、DE');
    requireValue(input.fillOnly === undefined || typeof input.fillOnly === 'boolean', 'fillOnly 必须是布尔值');
    requireValue(input.keepOpenOnFailure === undefined || typeof input.keepOpenOnFailure === 'boolean', 'keepOpenOnFailure 必须是布尔值');
    const trimmedUrl = input.url.trim();
    let sheeridVid;
    try {
      sheeridVid = verificationIdFromUrl(trimmedUrl);
    } catch (error) {
      if (error instanceof AutomationError) throw error;
      throw new AutomationError('INVALID_CONFIG', '请填写包含有效 ?verificationId= 的 SheerID 验证链接');
    }
    const raw = await this.readConfig();
    if (requestedProvider === 'nodemaven') {
      requireValue(Boolean(normalizeNodeMavenConfig(raw.nodemaven)),
        '尚未配置 NodeMaven 代理账号，请先在服务商配置中填写并保存，或选择 DataImpulse / 直连');
    } else if (requestedProvider === 'dataimpulse') {
      requireValue(Boolean(normalizeDataImpulseConfig(raw.dataimpulse)),
        '尚未配置 DataImpulse 代理账号，请先在服务商配置中填写并保存，或选择其他代理服务器');
    }
    const providedName = input.firstName?.trim() || input.lastName?.trim();
    requireValue(!providedName || (input.firstName?.trim() && input.lastName?.trim()),
      '自定义身份需要同时填写 firstName 和 lastName');
    const config = await normalizeConfig({
      ...raw,
      url: input.url.trim(),
      proxy: raw.proxy ?? 'direct',
      ...(requestedProvider !== undefined ? { proxyProvider: requestedProvider } : {}),
      profile: input.profile ?? 'google-one',
      materials: { ...(raw?.materials ?? {}), reuse: false },
      browser: { ...raw?.browser, keepOpenOnFailure: input.keepOpenOnFailure === true },
      data: {
        ...raw?.data,
        ...(input.countryCode?.trim() ? { countryCode: input.countryCode.trim().toUpperCase(), country: '' } : {}),
        ...(input.universityId ? { universityId: input.universityId } : {}),
        ...(input.firstName?.trim() ? { firstName: input.firstName.trim() } : {}),
        ...(input.lastName?.trim() ? { lastName: input.lastName.trim() } : {}),
        ...(input.birthDate?.trim() ? { birthDate: input.birthDate.trim() } : {}),
      },
    }, {});
    if (this.closing) throw new AutomationError('SERVER_STOPPING', '服务正在关闭');
    this.concurrency = config.web.concurrency;
    let id;
    do { id = randomBytes(12).toString('hex'); }
    while (this.jobs.has(id) || await materialExists(config.artifactsDir, id));
    const { promise: done, resolve: resolveDone } = Promise.withResolvers();
    const effectiveProvider = resolveDynamicProvider(config);
    const queuedAt = new Date().toISOString();
    const taskMeta = {
      taskId: id,
      sheeridVerificationId: sheeridVid,
      url: trimmedUrl,
      profile: input.profile ?? 'google-one',
      proxyProvider: effectiveProvider?.name ?? (config.proxyProvider === 'direct' ? 'direct' : 'configured'),
      countryCode: input.countryCode?.trim()?.toUpperCase() || null,
      universityId: input.universityId || null,
      firstName: input.firstName?.trim() || null,
      lastName: input.lastName?.trim() || null,
      birthDate: input.birthDate?.trim() || null,
      fillOnly: input.fillOnly === true,
      keepOpenOnFailure: input.keepOpenOnFailure === true,
      submittedAt: queuedAt,
    };
    const job = {
      id, url: trimmedUrl, profile: input.profile ?? 'google-one',
      proxyProvider: effectiveProvider?.name ?? (config.proxyProvider === 'direct' ? 'direct' : null),
      mode: input.fillOnly ? 'fill' : config.browser.autoFill ? 'submit' : 'manual', state: 'queued', stage: 'queued',
      queuedAt, startedAt: null, finishedAt: null, result: null,
      sequence: 0, events: [], controller: new AbortController(), config, done, resolveDone,
      material: null, taskMeta, sheeridVerificationId: sheeridVid,
    };
    this.jobs.set(id, job);
    // When a dynamic proxy provider is configured, proxy selection runs first
    // during execution and materials are generated afterward to match the
    // confirmed proxy country. Otherwise (direct/offline mode), prepare now.
    if (!effectiveProvider) {
      const materialVid = id;
      const materialLog = (event, fields = {}) => this.record(job, { event, ...fields });
      const prepared = await prepareMaterialsForConfig(config, { verificationId: materialVid, task: taskMeta, log: materialLog });
      job.material = await this.materialSnapshot(materialVid, prepared, { url: trimmedUrl, task: taskMeta });
      this.record(job, {
        event: 'material_ready', stage: 'queued', source: prepared.source,
        document: prepared.documentName, studentNumber: prepared.identity.studentNumber,
        university: prepared.identity.university?.name,
      });
    }
    this.queue.push(id);
    this.record(job, { event: 'web_queued', stage: 'queued', mode: job.mode });
    this.drain();
    return this.snapshot(job);
  }

  async materialSnapshot(id, prepared, extra = {}) {
    const task = prepared.material?.task ?? extra.task ?? null;
    return {
      verificationId: id,
      taskId: task?.taskId ?? id,
      sheeridVerificationId: task?.sheeridVerificationId ?? extra.sheeridVerificationId ?? null,
      url: task?.url ?? prepared.material?.url ?? extra.url ?? null,
      task,
      source: prepared.source,
      document: prepared.documentName,
      files: prepared.material.summary.files.map(file => ({ name: file.name, mimeType: file.mimeType, size: file.size })),
      university: prepared.identity.university ?? null,
      identity: {
        firstName: prepared.identity.firstName,
        lastName: prepared.identity.lastName,
        fullName: prepared.identity.fullName,
        birthDate: prepared.identity.birthDate,
        email: prepared.identity.email,
        studentNumber: prepared.identity.studentNumber,
        program: prepared.identity.program,
        address: prepared.identity.address,
      },
    };
  }

  drain() {
    if (this.closing || this.draining) return;
    this.draining = true;
    try {
      while (this.running.size < this.concurrency && this.queue.length) {
        const job = this.jobs.get(this.queue.shift());
        if (job.state !== 'queued') continue;
        job.state = 'running';
        job.startedAt = new Date().toISOString();
        this.running.add(job.id);
        this.record(job, { event: 'web_started', stage: 'starting', mode: job.mode });
        const config = job.config;
        void this.execute(job, config);
      }
    } finally { this.draining = false; }
  }

  record(job, record) {
    const event = { ...record, time: record.time ?? new Date().toISOString(), sequence: ++job.sequence };
    job.events.push(event);
    if (job.events.length > 400) job.events.shift();
    if (record.stage) job.stage = record.stage;
    if (record.event === 'run_finished') job.result = publicResult(record);
    if (record.event === 'verification_initialized' && record.verificationId) {
      job.sheeridVerificationId = record.verificationId;
      if (job.material) job.material.sheeridVerificationId = record.verificationId;
    }
    if (record.event === 'material_prepared' && job.config) {
      const artifactsDir = job.config.artifactsDir;
      const vid = record.verificationId ?? job.id;
      void readMaterial(artifactsDir, vid).then(archived => {
        if (!archived || job.material) return;
        const task = archived.task ?? job.taskMeta ?? null;
        job.material = {
          verificationId: String(vid).toLowerCase(),
          taskId: task?.taskId ?? job.id,
          sheeridVerificationId: task?.sheeridVerificationId ?? job.sheeridVerificationId ?? null,
          url: task?.url ?? archived.url ?? job.url ?? null,
          task,
          source: record.source ?? 'generated',
          document: record.document ?? archived.summary.files[0]?.name,
          files: archived.summary.files.map(file => ({ name: file.name, mimeType: file.mimeType, size: file.size })),
          university: archived.summary.university ?? null,
          identity: archived.summary.identity,
        };
      }).catch(() => {});
    }
  }

  async execute(job, config) {
    try {
      const result = await withLogSink(record => this.record(job, record), () => this.workflow(config, {
        submit: job.mode === 'submit', signal: job.controller.signal,
        resumeUncertainStage: job.resumeUncertainStage, jobId: job.id, taskMeta: job.taskMeta,
      }));
      job.result = publicResult(result);
      job.state = job.controller.signal.aborted ? 'cancelled'
        : ['failed', 'rejected', 'validation_failed'].includes(job.result.status) ? 'failed' : 'completed';
    } catch (error) {
      job.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.result = job.result?.status === 'submission_unknown' ? job.result : {
        status: 'failed', code: job.controller.signal.aborted ? 'CANCELLED'
          : error instanceof AutomationError ? error.code : 'WEB_WORKFLOW_ERROR',
        message: error instanceof AutomationError ? error.message : '任务执行失败，请查看进度记录',
        stage: error.stage ?? job.stage,
        ...(job.resumeUncertainStage ? { submissionUncertain: true, uncertainStage: job.resumeUncertainStage } : {}),
      };
    } finally {
      // Record the task outcome against the archived material so the archive shows
      // which documents were used and how the review ended.
      const materialVid = job.material?.verificationId ?? job.id;
      await recordMaterialTask(config.artifactsDir, materialVid, {
        ...(job.taskMeta ?? {}),
        ...(job.sheeridVerificationId ? { sheeridVerificationId: job.sheeridVerificationId } : {}),
      }).catch(() => {});
      await recordMaterialAttempt(config.artifactsDir, materialVid, {
        runId: job.result?.documentRunId ?? job.result?.runId ?? `web-${job.id}-${job.controller.signal.aborted ? 'cancelled' : 'finished'}`,
        status: job.result?.status, code: job.result?.code,
        stage: job.result?.documentStage ?? job.result?.stage,
        uploadAttempt: job.result?.uploadAttempt,
        document: job.material?.document,
      }).catch(() => {});
      // Workflow resolution includes browser/proxy cleanup. Only then release
      // the slot, including when cancellation occurs while launching a browser.
      this.finish(job);
    }
  }

  finish(job) {
    job.finishedAt = new Date().toISOString();
    // Stopped jobs retain their original settings for an explicit resume.
    if (job.state !== 'cancelled') delete job.config;
    this.record(job, { event: 'web_finished', ...job.result });
    // Persist the full event log to disk for post-mortem debugging.
    const artifactsDir = this.artifactsDir ?? resolve('.runs');
    const eventsFile = join(artifactsDir, `${job.id}.events.json`);
    const write = mkdir(artifactsDir, { recursive: true })
      .then(() => writeFile(eventsFile, `${JSON.stringify(job.events, null, 2)}\n`, { mode: 0o600 }))
      .catch(() => {})
      .finally(() => { this.pendingWrites.delete(write); });
    this.pendingWrites.add(write);
    this.running.delete(job.id);
    job.resolveDone();
    this.drain();
  }

  snapshot(job) {
    return { id: job.id, taskId: job.id, url: job.url, profile: job.profile, proxyProvider: job.proxyProvider ?? null, mode: job.mode, state: job.state, stage: job.stage,
      queuePosition: job.state === 'queued' ? this.queue.indexOf(job.id) + 1 : null,
      queuedAt: job.queuedAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      material: job.material, result: job.result, lastSequence: job.sequence };
  }

  list() {
    return { concurrency: this.concurrency, running: this.running.size, queued: this.queue.length,
      jobs: [...this.jobs.values()].map(job => this.snapshot(job)) };
  }

  get(id, after = 0) {
    const job = this.jobs.get(id.toLowerCase());
    if (!job) throw new AutomationError('JOB_NOT_FOUND', '任务不存在或已过期');
    return { job: this.snapshot(job), events: job.events.filter(event => event.sequence > after) };
  }

  cancel(id) {
    const job = this.jobs.get(id.toLowerCase());
    if (!job) throw new AutomationError('JOB_NOT_FOUND', '任务不存在或已过期');
    if (job.state === 'queued') {
      this.queue = this.queue.filter(queuedId => queuedId !== job.id);
      job.controller.abort();
      job.state = 'cancelled';
      job.stage = 'cancelled';
      job.result = { status: 'cancelled', code: 'CANCELLED', message: '排队任务已取消，未执行',
        ...(job.resumeUncertainStage ? { submissionUncertain: true, uncertainStage: job.resumeUncertainStage } : {}) };
      this.finish(job);
    } else if (job.state === 'running') {
      job.state = 'cancelling';
      this.record(job, { event: 'web_cancelling', code: 'CANCELLED' });
      job.controller.abort();
    }
    return this.snapshot(job);
  }

  resume(id) {
    if (this.closing) throw new AutomationError('SERVER_STOPPING', '服务正在关闭');
    const job = this.jobs.get(id.toLowerCase());
    if (!job) throw new AutomationError('JOB_NOT_FOUND', '任务不存在或已过期');
    // Repeated clicks are idempotent. Cleanup must finish before a fresh run.
    if (['queued', 'running'].includes(job.state)) return this.snapshot(job);
    if (job.state !== 'cancelled' || !job.finishedAt || !job.config) {
      throw new AutomationError('JOB_NOT_RESUMABLE', '仅已停止且完成资源清理的任务可以恢复');
    }
    const { promise: done, resolve: resolveDone } = Promise.withResolvers();
    job.resumeUncertainStage = job.result?.uncertainStage
      || (job.result?.submissionUncertain || job.result?.status === 'submission_unknown'
        ? (job.result?.documentStage || (job.result?.browserOpened === false ? 'complete_upload' : 'personal_info')) : undefined);
    Object.assign(job, { state: 'queued', stage: 'queued', queuedAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, result: null, controller: new AbortController(), done, resolveDone });
    this.queue.push(job.id);
    this.record(job, { event: 'web_resumed', stage: 'queued', mode: job.mode });
    this.drain();
    return this.snapshot(job);
  }

  remove(id) {
    if (this.closing) throw new AutomationError('SERVER_STOPPING', '服务正在关闭');
    const job = this.jobs.get(id.toLowerCase());
    if (!job) throw new AutomationError('JOB_NOT_FOUND', '任务不存在或已过期');
    if (!job.finishedAt || !['completed', 'failed', 'cancelled'].includes(job.state)
      || this.running.has(job.id) || this.queue.includes(job.id)) {
      throw new AutomationError('JOB_ACTIVE', '请先停止任务，等待资源清理完成后再删除');
    }
    this.jobs.delete(job.id);
    return { id: job.id, deleted: true };
  }

  async getEvents(id) {
    const lower = String(id).toLowerCase();
    const job = this.jobs.get(lower);
    if (job) return JSON.stringify(job.events, null, 2);
    // Server may have restarted — try reading the persisted events file.
    const artifactsDir = this.artifactsDir ?? resolve('.runs');
    try { return await readFile(join(artifactsDir, `${lower}.events.json`), 'utf8'); }
    catch { throw new AutomationError('JOB_NOT_FOUND', '任务日志不存在或已过期'); }
  }

  async close() {
    this.closing = true;
    await this.admissions;
    for (const job of this.jobs.values()) if (!job.finishedAt) this.cancel(job.id);
    await Promise.all([...this.jobs.values()].map(job => job.done));
    while (this.pendingWrites.size) await Promise.all([...this.pendingWrites]);
  }
}

function publicResult(result = {}) {
  const keys = ['status', 'code', 'message', 'stage', 'runId', 'currentStep', 'errorIds',
    'durationMs', 'browserOpened', 'submissionAttempted', 'remoteWriteAttempted',
    'lastKnownStep', 'documentRunId', 'documentStage', 'uploadAttempt', 'rejectionReasons', 'submissionUncertain', 'uncertainStage'];
  return Object.fromEntries(keys.filter(key => result[key] !== undefined).map(key => [key, result[key]]));
}
