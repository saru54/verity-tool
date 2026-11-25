import { randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AutomationError, requireValue } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { withTaskLock, saveResult } from '../../core/storage.js';
import { recordMaterialAttempt } from '../../core/materials-store.js';
import { createVerificationClient, validateUploadUrl } from './client.js';
import { readDocument, selectDocumentSource } from './document.js';
import { getProfile } from './profiles/index.js';
import { withNetwork } from '../../core/network.js';

function randomNumericPdfName(usedNames) {
  let candidate;
  do {
    candidate = `${randomInt(100_000, 100_000_000)}.pdf`;
  } while (usedNames.has(candidate));
  usedNames.add(candidate);
  return candidate;
}

async function readArchivedPdfPaths(primaryPath) {
  const dir = dirname(primaryPath);
  const primaryName = basename(primaryPath);
  let material;
  try {
    material = JSON.parse(await readFile(join(dir, 'material.json'), 'utf8'));
  } catch {
    return null;
  }
  const files = material?.summary?.files ?? material?.files ?? [];
  if (!Array.isArray(files)) return null;
  const pdfNames = files
    .map(entry => entry?.name)
    .filter(name => typeof name === 'string'
      && name.toLowerCase().endsWith('.pdf')
      && !name.includes('/') && !name.includes('\\'));
  if (!pdfNames.length) return null;
  const ordered = [
    ...(pdfNames.includes(primaryName) ? [primaryName] : []),
    ...pdfNames.filter(name => name !== primaryName),
  ];
  return [...new Set(ordered)].map(name => join(dir, name));
}

async function readAttemptDocuments(source, { file, url, signal, timeoutMs }) {
  // Explicit --file / --url overrides and remote URLs are always read verbatim.
  if (file !== undefined || url !== undefined || !source?.path) {
    return [await readDocument(source, { signal, timeoutMs })];
  }
  const archivedPaths = await readArchivedPdfPaths(source.path);
  if (!archivedPaths) {
    return [await readDocument(source, { signal, timeoutMs })];
  }
  const usedNames = new Set();
  const docs = [];
  for (const pdfPath of archivedPaths) {
    const doc = await readDocument({ path: pdfPath }, { signal, timeoutMs });
    docs.push({ ...doc, fileName: randomNumericPdfName(usedNames) });
  }
  return docs;
}

function describe(state) {
  const statuses = {
    success: ['verified', '验证已通过'], pending: ['pending', '材料正在等待审核'],
    docUpload: ['document_required', '当前需要上传证明材料'], sso: ['sso_required', '当前需要学校登录或材料验证'],
    emailLoop: ['email_required', '当前需要完成邮件验证'],
    collectStudentPersonalInfo: ['personal_info_required', '当前仍需完成学生资料步骤'],
    error: ['rejected', '当前验证被拒绝或发生错误，已停止流程'],
  };
  const [status, message] = state.errorIds.length ? statuses.error
    : Object.hasOwn(statuses, state.currentStep) ? statuses[state.currentStep] : ['not_actionable', '当前步骤不在材料上传流程内'];
  return { status, message, ...state, code: 'VERIFICATION_STATE' };
}

export function runDocumentWorkflow(config, options = {}) {
  return withNetwork(config, () => executeDocumentWorkflow(config, options));
}

async function executeDocumentWorkflow(config, options) {
  const { file, url, signal } = options;
  requireValue(config.app === 'sheerid', '当前纯接口材料流程仅支持 sheerid');
  requireValue(!(file !== undefined && url !== undefined), '--file 与 --url 只能指定一个');
  const client = createVerificationClient(config, signal);
  return withTaskLock(config.artifactsDir, `sheerid:${client.verificationId}`,
    () => executeLockedDocumentWorkflow(config, options, client));
}

async function executeLockedDocumentWorkflow(config, { submit = false, file, url, signal, uncertainSubmission = false, resumeUncertainStage, beforeDocumentUpload, browserUpload }, client) {
  const runId = randomUUID();
  const log = createLogger(runId);
  const started = Date.now();
  const intervalMs = config.polling?.intervalMs ?? 5000;
  const reviewRange = config.polling?.reviewDelayMs
    ?? (config.polling?.intervalMs !== undefined
      ? { min: intervalMs, max: intervalMs }
      : { min: 10000, max: 20000 });
  const nextReviewDelay = () => reviewRange.min === reviewRange.max
    ? reviewRange.min
    : reviewRange.min + Math.floor(Math.random() * (reviewRange.max - reviewRange.min + 1));
  let stage = 'query_status', state, result;
  let remoteWriteAttempted = false, submissionAttempted = false, inFlight = false;
  let uploadAttempt = 0;
  let uploadedDocument = null;
  let uncertainStage = resumeUncertainStage || (uncertainSubmission ? 'personal_info' : null);
  const envelope = outcome => ({
    runId, app: config.app, mode: submit ? 'api_submit' : 'api_status', browserOpened: false,
    startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started, stage, remoteWriteAttempted, submissionAttempted, uploadAttempt, ...outcome,
  });
  const wait = async milliseconds => {
    // Chunk long Retry-After delays to avoid the JS timer limit; every wait is cancellable.
    for (let remaining = milliseconds; remaining > 0; remaining -= Math.min(remaining, 60000)) {
      await delay(Math.min(remaining, 60000), undefined, { signal });
    }
    signal?.throwIfAborted();
  };
  const query = async () => {
    let failures = 0;
    while (true) {
      signal?.throwIfAborted();
      stage = 'query_status';
      try {
        const response = await client.getStatus();
        log('verification_status', { stage, ...response.state });
        return response.state;
      } catch (error) {
        const transient = ['API_NETWORK_ERROR', 'API_TIMEOUT'].includes(error.code) || error.httpStatus >= 500
          || (error.httpStatus === 429 && error.retryAfterSeconds !== undefined && !error.terminal);
        if (!submit || signal?.aborted || !transient) throw error;
        const delayMs = Math.max(Math.min(intervalMs * 2 ** Math.min(failures++, 6), 60000), (error.retryAfterSeconds ?? 0) * 1000);
        stage = 'wait_review';
        log('status_query_retry', { stage, code: error.code, delayMs });
        await wait(delayMs);
      }
    }
  };
  const write = async (nextStage, operation, meta = {}) => {
    signal?.throwIfAborted();
    stage = nextStage;
    remoteWriteAttempted = true;
    if (stage === 'complete_upload') submissionAttempted = true;
    await saveResult(config.artifactsDir, envelope({ status: 'submission_unknown', code: 'REMOTE_OPERATION_STARTED' }));
    log('stage_started', { stage, uploadAttempt, ...meta });
    inFlight = true;
    const response = await operation();
    inFlight = false;
    log('stage_completed', { stage, uploadAttempt, ...meta });
    return response;
  };
  const upload = async () => {
    // Release the browser before uploading only when continuing via headless API.
    if (!browserUpload && state.currentStep === 'docUpload') await beforeDocumentUpload?.();
    stage = 'read_document';
    uploadAttempt++;
    log(uploadAttempt > 1 || state.rejectionReasons.length ? 'document_refetch' : 'stage_started', {
      stage, uploadAttempt, rejectionReasons: state.rejectionReasons,
    });
    // Reread all generated PDFs with fresh random numeric names on every attempt.
    const source = selectDocumentSource(config.document, { file, url }, config.data);
    const documents = await readAttemptDocuments(source, {
      file, url, signal, timeoutMs: config.timeouts.downloadMs,
    });
    if (state.currentStep === 'sso' && !browserUpload) {
      ({ state } = await write('cancel_sso', () => client.cancelSso()));
      log('verification_status', { stage, ...state });
      if (state.errorIds.length || state.currentStep !== 'docUpload') return;
      await beforeDocumentUpload?.();
    }
    if (browserUpload) {
      stage = 'browser_doc_upload';
      const uploadedNames = documents.map(doc => doc.fileName);
      log('stage_started', { stage, uploadAttempt, step: state.currentStep, files: uploadedNames });
      const postState = await browserUpload(documents, {
        step: state.currentStep,
        client,
        verificationId: client.verificationId,
        markSubmissionStarted: async () => {
          remoteWriteAttempted = true;
          submissionAttempted = true;
          inFlight = true;
          await saveResult(config.artifactsDir, envelope({ status: 'submission_unknown', code: 'REMOTE_OPERATION_STARTED' }));
        },
      });
      inFlight = false;
      uploadedDocument = uploadedNames.join(', ');
      log('stage_completed', { stage, uploadAttempt, files: uploadedNames });
      state = postState;
      return;
    }
    const initiated = await write('initiate_upload', () => client.initiateUpload(documents.map(doc => ({
      fileName: doc.fileName, mimeType: doc.mimeType, fileSize: doc.fileSize,
    }))));
    state = initiated.state;
    if (state.errorIds.length || state.currentStep !== 'docUpload') return;
    const allocated = initiated.body.documents;
    if (!Array.isArray(allocated) || allocated.length !== documents.length) {
      throw new AutomationError('UPLOAD_NOT_ALLOCATED', '接口返回的文档上传槽位数量与材料数量不一致，未上传文件');
    }
    for (let i = 0; i < documents.length; i++) {
      const slot = allocated[i];
      const doc = documents[i];
      if (!slot || (slot.errors != null && (!Array.isArray(slot.errors) || slot.errors.length))) {
        throw new AutomationError('UPLOAD_NOT_ALLOCATED', '接口未返回有效的文档上传记录，未上传文件');
      }
      if ((slot.mimeType != null && slot.mimeType !== doc.mimeType)
        || (slot.fileSize != null && slot.fileSize !== doc.fileSize)) {
        throw new AutomationError('UPLOAD_METADATA_MISMATCH', '服务端文档记录与材料的格式或大小不一致，未上传文件');
      }
      const uploadUrl = validateUploadUrl(slot.uploadUrl);
      await write('upload_bytes', () => client.upload(uploadUrl, doc), {
        fileName: doc.fileName,
        fileIndex: i + 1,
        fileCount: documents.length,
      });
    }
    ({ state } = await write('complete_upload', () => client.completeUpload()));
    uploadedDocument = documents.map(doc => doc.fileName).join(', ');
  };
  try {
    log('run_started', { app: config.app, stage, mode: submit ? 'api_submit' : 'api_status' });
    state = await query();
    if (!submit) { result = envelope(describe(state)); return result; }
    while (true) {
      signal?.throwIfAborted();
      if (state.currentStep === 'success' && !state.errorIds.length) {
        result = envelope(describe(state)); break;
      }
      if (state.currentStep === 'error' || state.errorIds.length) {
        result = envelope({ ...describe(state), status: 'failed' }); break;
      }
      // A read confirming progress resolves an ambiguous earlier write. If the
      // server remains at its old step, only poll: do not repeat that write.
      if (state.currentStep === 'pending' || state.currentStep === 'emailLoop'
        || (uncertainStage === 'personal_info' && ['sso', 'docUpload'].includes(state.currentStep))
        || (uncertainStage === 'cancel_sso' && state.currentStep === 'docUpload')) uncertainStage = null;
      if (['sso', 'docUpload'].includes(state.currentStep) && !uncertainStage) {
        try { await upload(); }
        catch (error) {
          const knownRejection = error.httpStatus >= 400 && error.httpStatus < 500;
          if (knownRejection) inFlight = false;
          if (!inFlight || knownRejection || signal?.aborted) throw error;
          uncertainStage = stage;
          inFlight = false;
          log('submission_uncertain', { stage, status: 'submission_unknown', code: error.code });
        }
        if (state.currentStep === 'success' || state.currentStep === 'error' || state.errorIds.length) continue;
      } else if (!['pending', 'emailLoop', 'sso', 'docUpload'].includes(state.currentStep)
        && !(uncertainStage === 'personal_info' && state.currentStep === (config.program?.step ?? 'collectStudentPersonalInfo'))) {
        result = envelope({ status: 'failed', code: 'UNSUPPORTED_VERIFICATION_STEP', ...state,
          message: '当前步骤无法由材料流程继续，请按验证页面提示处理' }); break;
      }
      // For profiles where pending review is the final desired outcome (e.g.
      // Spotify), stop once documents are submitted and the verification enters
      // pending — do not keep polling for SheerID's final verdict.
      if (state.currentStep === 'pending' && !uncertainStage
        && getProfile(config.profile)?.pendingIsFinal) {
        log('pending_final', { stage: 'wait_review', ...state, code: 'PENDING_IS_FINAL' });
        result = envelope(describe(state));
        break;
      }
      const delayMs = nextReviewDelay();
      stage = 'wait_review';
      log('waiting_for_review', { stage, ...state, uploadAttempt,
        code: uncertainStage ? 'AWAITING_WRITE_CONFIRMATION' : state.currentStep === 'emailLoop' ? 'AWAITING_EMAIL' : 'AWAITING_REVIEW',
        delayMs });
      await wait(delayMs);
      state = await query();
    }
  } catch (error) {
    result = envelope({ status: 'failed',
      code: signal?.aborted ? 'CANCELLED' : error instanceof AutomationError ? error.code : 'DOCUMENT_WORKFLOW_ERROR',
      message: signal?.aborted ? '任务已停止；已提交操作的最终状态以服务端为准'
        : error instanceof AutomationError ? error.message : '材料接口流程失败，已停止操作',
      lastKnownStep: state?.currentStep, submissionUncertain: Boolean(uncertainStage || inFlight),
      uncertainStage: uncertainStage || (inFlight ? stage : undefined),
    });
  } finally {
    if (result) { await saveResult(config.artifactsDir, result); log('run_finished', result); }
  }
  return result;
}
