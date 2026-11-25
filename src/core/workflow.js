import { AutomationError, requireValue } from './errors.js';
import { createVerificationClient, verificationIdFromUrl } from '../apps/sheerid/client.js';
import { parseProgramFromUrl, buildProgramProfile } from '../apps/sheerid/program-profile.js';
import { runDocumentWorkflow } from '../apps/sheerid/document-workflow.js';
import { withNetwork } from './network.js';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
import { queryStatusWithRetry } from './status-query.js';
import {
  findLatestMaterialByVerificationId, prepareArchivedMaterialsForConfig, prepareMaterialsForConfig,
} from './materials-store.js';
import { ensureIpQuality } from './ip-quality.js';
import { resolveDynamicProvider, parseProxy } from './proxy.js';
import { pickUniversity } from '../materials/index.js';

const SUPPORTED_MATERIAL_COUNTRIES = new Set(['US', 'CA', 'GB', 'DE']);

async function resolveInitialCountryCode(config, { parsed, existingArchiveMatch }) {
  if (config.data?.universityId) {
    const university = await pickUniversity({
      universityId: config.data.universityId,
      countryCode: parsed.country ?? config.data?.countryCode ?? 'US',
    }).catch(() => null);
    if (university?.countryCode) return { countryCode: university.countryCode, locked: true };
  }
  if (existingArchiveMatch?.material?.summary?.university?.countryCode) {
    return { countryCode: String(existingArchiveMatch.material.summary.university.countryCode).toUpperCase(), locked: false };
  }
  const code = parsed.country ?? config.data?.countryCode ?? (config.data?.country === 'United States' ? 'US' : undefined) ?? 'US';
  return { countryCode: String(code).toUpperCase(), locked: false };
}

function hasExplicitOperatorMaterialInput(config, file, documentUrl) {
  return Boolean(
    file !== undefined
    || documentUrl !== undefined
    || config.document?.path?.trim()
    || config.document?.url?.trim()
    || config.data?.universityId
    || config.data?.firstName?.trim()
    || config.data?.lastName?.trim()
  );
}

// Select an executor from the current server state. Each executor rechecks under its task lock
// before making changes, so routing never bypasses the existing preflight or error handling.
export function runWorkflow(config, options = {}) {
  return executeWorkflow(config, options);
}

async function executeWorkflow(config, { submit = false, statusOnly = false, file, url: documentUrl, signal, resumeUncertainStage, jobId, taskMeta = null } = {}) {
  requireValue(config.app === 'sheerid', '当前自动分流仅支持 sheerid');
  requireValue(!(statusOnly && submit), '--status 与 --submit 不能同时使用');
  requireValue(!(file !== undefined && documentUrl !== undefined), '--file 与 --url 只能指定一个');
  if (statusOnly) return runDocumentWorkflow(config, { signal });
  signal?.throwIfAborted();
  const log = createLogger(randomUUID());

  const parsed = parseProgramFromUrl(config.url);
  config.programId = parsed.programId;
  const sheeridVid = verificationIdFromUrl(config.url);
  config.program = buildProgramProfile(parsed, { verificationId: sheeridVid });
  const vid = jobId ?? sheeridVid;
  const effectiveTaskMeta = {
    ...(taskMeta ?? {}),
    taskId: taskMeta?.taskId ?? vid,
    sheeridVerificationId: sheeridVid,
    url: taskMeta?.url ?? config.url,
  };
  // If resuming a ?verificationId= that already has an archive on disk and no
  // operator overrides were supplied, hold material preparation until preflight
  // checks whether the form was already submitted.
  const existingArchiveMatch = (config.materials?.enabled !== false && !hasExplicitOperatorMaterialInput(config, file, documentUrl))
    ? await findLatestMaterialByVerificationId(config.artifactsDir, sheeridVid)
    : null;

  let reusedBridge = null;
  let reusedSession = null;

  try {
    // 1. Select & verify proxy FIRST so materials match the winning proxy's country,
    // and reuse the screened Camoufox browser/bridge instead of restarting it.
    const provider = resolveDynamicProvider(config);
    if (provider) {
      const { countryCode: initialCountry, locked: countryLocked } = await resolveInitialCountryCode(config, { parsed, existingArchiveMatch });
      if (!config.proxy) {
        const sid = (`s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`).replace(/[^a-z0-9]/g, '').slice(0, 13);
        config.proxy = parseProxy(provider.build(provider.config, { countryCode: initialCountry, sessionId: sid }));
      }
      if (config.ipQuality?.enabled !== false) {
        log('stage_started', { stage: 'ip_quality', provider: provider.name });
        const iqResult = await ensureIpQuality(config, config.proxy, { log, signal });
        if (!iqResult.skipped) {
          config.proxy = iqResult.proxy;
          reusedBridge = iqResult.bridge ?? null;
          reusedSession = iqResult.session ?? null;
          const winningCode = String(iqResult.country ?? initialCountry).toUpperCase();
          if (!countryLocked && SUPPORTED_MATERIAL_COUNTRIES.has(winningCode)) {
            config.data = { ...config.data, countryCode: winningCode, country: '' };
          }
          log('ip_quality_done', {
            stage: 'ip_quality',
            provider: iqResult.provider ?? provider.name,
            ip: iqResult.ip, score: iqResult.score, grade: iqResult.grade,
            country: iqResult.country, sessionId: iqResult.sessionId,
            ipType: iqResult.ipType, asn: iqResult.asn, asnOwner: iqResult.asnOwner,
            attempts: iqResult.attempts.length,
          });
        }
      }
    }

    // 2. Generate/prepare materials AFTER proxy selection unless an existing
    // ?verificationId= archive is waiting for post-form preflight verification.
    if (config.materials?.enabled !== false && !existingArchiveMatch) {
      const material = await prepareMaterialsForConfig(config, { verificationId: vid, task: effectiveTaskMeta, log });
      log('material_prepared', {
        stage: 'material', source: material.source, document: material.documentName,
        studentNumber: material.identity.studentNumber, university: material.identity.university?.id,
        verificationId: vid,
      });
    }

    // 3. Enter withNetwork (reusing the screening bridge when available) and run
    // the workflow reusing the screened browser session.
    const bridgeForNetwork = reusedBridge;
    reusedBridge = null;
    const claimSession = () => {
      const owned = reusedSession;
      reusedSession = null;
      return owned;
    };
    return await withNetwork(
      config,
      () => routeWithProxy(config, { submit, file, documentUrl, signal, log, vid, existingArchiveMatch, taskMeta: effectiveTaskMeta, resumeUncertainStage, claimSession }),
      { existingBridge: bridgeForNetwork },
    );
  } finally {
    await reusedSession?.close?.().catch(() => {});
    await reusedBridge?.close?.().catch(() => {});
  }
}

async function prepareDeferredMaterial(config, { vid, existingArchiveMatch, useArchived, taskMeta, log }) {
  if (config.materials?.enabled === false) return;
  const material = (useArchived && existingArchiveMatch)
    ? (await prepareArchivedMaterialsForConfig(config, {
      verificationId: vid,
      sourceVerificationId: existingArchiveMatch.archiveId,
      task: taskMeta,
    }) ?? await prepareMaterialsForConfig(config, { verificationId: vid, task: taskMeta, log }))
    : await prepareMaterialsForConfig(config, { verificationId: vid, task: taskMeta, log });
  log('material_prepared', {
    stage: 'material', source: material.source, document: material.documentName,
    studentNumber: material.identity.studentNumber, university: material.identity.university?.id,
    verificationId: vid,
  });
}

async function routeWithProxy(config, { submit, file, documentUrl, signal, log, vid, existingArchiveMatch, taskMeta, resumeUncertainStage, claimSession }) {
  if (resumeUncertainStage) {
    if (existingArchiveMatch) await prepareDeferredMaterial(config, { vid, existingArchiveMatch, useArchived: true, taskMeta, log });
    return runDocumentWorkflow(config, { submit, file, url: documentUrl, signal, resumeUncertainStage });
  }

  log('stage_started', { stage: 'preflight' });
  const client = createVerificationClient(config, signal);
  const { state } = await queryStatusWithRetry(() => client.getStatus(), {
    signal, intervalMs: config.polling?.intervalMs, log,
  });
  log('verification_status', { stage: 'preflight', ...state });
  const expectedStep = config.program?.step ?? 'collectStudentPersonalInfo';
  if (existingArchiveMatch) {
    const alreadySubmittedForm = state.currentStep !== expectedStep || state.errorIds.length > 0;
    await prepareDeferredMaterial(config, { vid, existingArchiveMatch, useArchived: alreadySubmittedForm, taskMeta, log });
  }
  if (state.currentStep === expectedStep && state.errorIds.length === 0) {
    requireValue(config.browser.autoFill !== false || !submit,
      '自动填写已关闭，请在浏览器中手动填写；进入材料步骤后可使用 --submit 上传材料');
    const url = new URL(config.url);
    if (url.origin !== 'https://services.sheerid.com' || !/^\/verify\/[a-f\d]{24}\/?$/i.test(url.pathname)) {
      throw new AutomationError('FORM_URL_REQUIRED', '当前需要填写表单，请将 url 设置为包含 verificationId 的完整 SheerID 验证页面链接（如 https://services.sheerid.com/verify/{id}/）');
    }
    // Load the browser module only for the browser branch; status/material-only runs stay browser-free.
    const { runAutomation } = await import('./runner.js');
    return runAutomation(config, {
      submit, signal, existingSession: claimSession?.(),
      afterSubmit: submit
        ? ({ uncertainSubmission = false, beforeDocumentUpload, browserUpload } = {}) => runDocumentWorkflow(config, {
          submit: true, file, url: documentUrl, signal, uncertainSubmission, beforeDocumentUpload, browserUpload,
        })
        : undefined,
    });
  }
  // When the verification is already at docUpload or sso and browser execution
  // is allowed, launch/reuse the screened browser to upload via page DOM so
  // JS fingerprinting and session behavior match fresh runs. Keep the headless
  // API path only when autoFill === false, for read-only --status, or polling
  // non-upload steps (pending / emailLoop).
  const isVerifyPageUrl = (() => {
    try {
      const parsedUrl = new URL(config.url);
      return parsedUrl.origin === 'https://services.sheerid.com' && /^\/verify\/[a-f\d]{24}\/?$/i.test(parsedUrl.pathname);
    } catch {
      return false;
    }
  })();
  if (submit && config.browser?.autoFill !== false && ['docUpload', 'sso'].includes(state.currentStep)
    && state.errorIds.length === 0 && isVerifyPageUrl) {
    log('stage_started', { stage: 'document_direct', code: 'BROWSER_DOCUMENT_MODE', currentStep: state.currentStep });
    const { runAutomation } = await import('./runner.js');
    return runAutomation(config, {
      submit: true,
      signal,
      existingSession: claimSession?.(),
      documentOnly: { status: state.currentStep === 'sso' ? 'sso_required' : 'document_required' },
      afterSubmit: ({ uncertainSubmission = false, beforeDocumentUpload, browserUpload } = {}) => runDocumentWorkflow(config, {
        submit: true, file, url: documentUrl, signal, uncertainSubmission, beforeDocumentUpload, browserUpload,
      }),
    });
  }
  log('stage_started', { stage: 'document_direct', code: 'FORM_ALREADY_FILLED', currentStep: state.currentStep });
  return runDocumentWorkflow(config, { submit, file, url: documentUrl, signal });
}
