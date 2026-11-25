import { setTimeout as delay } from 'node:timers/promises';
import { AutomationError } from '../../core/errors.js';

const DROPZONE_INPUT_SELECTOR = '.sid-docdrop-wrap__dropzone input[type="file"], .sid-upload-wrap input[type="file"]';
const ADD_MORE_INPUT_SELECTOR = 'input#sid-take-photo-input[type="file"], .sid-add-more-files input[type="file"]';
const ANY_FILE_INPUT_SELECTOR = '#sid-step-doc-upload input[type="file"], .sid-doc-upload-redesign-container input[type="file"], .sid-step-doc-upload input[type="file"], input[type="file"]';
const FILE_ITEM_SELECTOR = '.sid-file-list__name';
const FILE_NAME_SELECTOR = '.sid-file-list__name';
const FILE_REMOVE_SELECTOR = '.sid-file-list__remove-btn, .sid-file-list__remove, .sid-file-list__file button[aria-label]';
const SUBMIT_BUTTON_SELECTOR = '#sid-submit-doc-upload, button[type="submit"].sid-doc-upload-submit-btn, button[type="submit"].sid-btn';
const DOC_UPLOAD_STEP_SELECTOR = '#sid-step-doc-upload, .sid-doc-upload-redesign-container, .sid-step-doc-upload';
const SSO_STEP_SELECTOR = '#sid-step-sso, [data-testid="sid-step-sso"], .sid-sso-container';
const SSO_CANCEL_BTN_SELECTOR = '.sid-sso-pending-submit-btn, #sid-step-sso button[class*="pending-submit"], [data-testid="sid-step-sso"] button[class*="pending-submit"]';
const SSO_LOGIN_BTN_SELECTOR = '#sid-submit-btn-sso, .sid-sso-submit-btn';

async function isVisible(locator, timeoutMs = 1500) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function waitForDocUploadContainer(page, { step, client, interaction, timeoutMs, navigationMs, signal, log }) {
  const stepLocator = page.locator(DOC_UPLOAD_STEP_SELECTOR).first();
  const input = page.locator(ANY_FILE_INPUT_SELECTOR).first();
  const initialProbeMs = step === 'sso' ? Math.min(timeoutMs, 2500) : Math.min(timeoutMs, 8000);
  try {
    await stepLocator.waitFor({ state: 'visible', timeout: initialProbeMs });
    await input.waitFor({ state: 'attached', timeout: 3000 });
    return null;
  } catch {
    signal?.throwIfAborted();
  }

  const ssoVisible = step === 'sso' || (await isVisible(page.locator(SSO_STEP_SELECTOR), 1000));
  if (ssoVisible) {
    const cancelBtn = page.locator(SSO_CANCEL_BTN_SELECTOR).first();
    const loginBtn = page.locator(SSO_LOGIN_BTN_SELECTOR).first();

    // First look for the direct "Upload Proof of Enrollment" / cancel-SSO button
    // (rendered when SSO mode is active or inline cancel option is exposed).
    let cancelReady = await isVisible(cancelBtn, 1500);
    if (!cancelReady && await isVisible(loginBtn, 1500)) {
      // SheerID's StepSSO hides the cancel button behind isSingleSignOnActive
      // until the portal login button is clicked (which opens window.open).
      // Intercept and close that popup tab automatically, then click cancel.
      const ctx = typeof page.context === 'function' ? page.context() : null;
      const closePopup = popup => { popup?.close?.().catch(() => {}); };
      ctx?.on?.('page', closePopup);
      try {
        await interaction?.beforeSubmit?.();
        if (interaction?.click) await interaction.click(loginBtn, { timeout: 5000 }).catch(() => {});
        else await loginBtn.click({ timeout: 5000 }).catch(() => {});
        cancelReady = await isVisible(cancelBtn, 4000);
      } finally {
        ctx?.off?.('page', closePopup);
        ctx?.removeListener?.('page', closePopup);
      }
    }

    if (cancelReady) {
      await interaction?.beforeSubmit?.();
      if (interaction?.click) await interaction.click(cancelBtn, { timeout: 5000 }).catch(() => {});
      else await cancelBtn.click({ timeout: 5000 }).catch(() => {});
      try {
        await stepLocator.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 10000) });
        await input.waitFor({ state: 'attached', timeout: 3000 });
        log?.('browser_sso_cancelled', { stage: 'browser_doc_upload', via: 'page_click' });
        return null;
      } catch {
        signal?.throwIfAborted();
      }
    }

    if (client?.cancelSso) {
      log?.('browser_sso_cancel_fallback', { stage: 'browser_doc_upload' });
      const { state } = await client.cancelSso();
      log?.('verification_status', { stage: 'browser_doc_upload', ...state });
      if (state.errorIds.length || state.currentStep !== 'docUpload') return state;
    }
  }

  log?.('browser_doc_upload_reload', { stage: 'browser_doc_upload', reason: 'STEP_CONTAINER_NOT_READY' });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: navigationMs });
  await stepLocator.waitFor({ state: 'visible', timeout: timeoutMs });
  await input.waitFor({ state: 'attached', timeout: timeoutMs });
  return null;
}

async function clearStagedFiles(page, signal) {
  const files = page.locator(FILE_ITEM_SELECTOR);
  let count = await files.count();
  for (let i = 0; i < 6 && count > 0; i++) {
    signal?.throwIfAborted();
    const removeButtons = page.locator(FILE_REMOVE_SELECTOR);
    if ((await removeButtons.count()) === 0) break;
    await removeButtons.first().click({ timeout: 2000 }).catch(() => {});
    await delay(150, undefined, { signal });
    count = await files.count();
  }
}

async function countStagedFiles(page) {
  try {
    return await page.locator(FILE_ITEM_SELECTOR).count();
  } catch {
    return 0;
  }
}

async function waitForStagedCount(page, targetCount, { timeoutMs = 4000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const count = await countStagedFiles(page);
    if (count >= targetCount) return count;
    await delay(150, undefined, { signal });
  }
  return countStagedFiles(page);
}

async function waitForSubmitEnabled(submitButton, { timeoutMs = 6000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const visible = await submitButton.isVisible().catch(() => false);
    const disabled = await submitButton.isDisabled().catch(() => true);
    const ariaDisabled = await submitButton.getAttribute('aria-disabled').catch(() => 'true');
    if (visible && !disabled && ariaDisabled !== 'true') return true;
    await delay(150, undefined, { signal });
  }
  return false;
}

async function attachDocuments(page, documents, { signal, log }) {
  await clearStagedFiles(page, signal);
  const payloads = documents.map(doc => ({
    name: doc.fileName,
    mimeType: doc.mimeType,
    buffer: doc.bytes,
  }));

  let primaryInput = page.locator(DROPZONE_INPUT_SELECTOR).first();
  if ((await primaryInput.count()) === 0) {
    primaryInput = page.locator(ANY_FILE_INPUT_SELECTOR).first();
  }
  await primaryInput.setInputFiles(payloads);
  let staged = await waitForStagedCount(page, payloads.length, { timeoutMs: 3500, signal });

  // Some builds only read the first entry when multiple files arrive in a single
  // change event on the initial dropzone; add any remaining files individually via
  // the secondary "add more" input.
  if (staged < payloads.length) {
    for (let i = Math.max(staged, 1); i < payloads.length; i++) {
      signal?.throwIfAborted();
      let addMore = page.locator(ADD_MORE_INPUT_SELECTOR).first();
      if ((await addMore.count()) === 0) {
        addMore = page.locator(ANY_FILE_INPUT_SELECTOR).first();
      }
      await addMore.setInputFiles(payloads[i]);
      staged = await waitForStagedCount(page, i + 1, { timeoutMs: 3000, signal });
    }
  }

  const attachedNames = await page.locator(FILE_NAME_SELECTOR).allTextContents().catch(() => []);
  log?.('browser_doc_files_attached', {
    stage: 'browser_doc_upload',
    expected: payloads.length,
    staged,
    fileNames: attachedNames.map(name => name.trim()).filter(Boolean),
  });
  if (staged < payloads.length) {
    throw new AutomationError('BROWSER_DOC_ATTACH_FAILED',
      `页面仅成功挂载 ${staged}/${payloads.length} 份证明文件`);
  }
}

export async function uploadDocumentsInBrowser(page, documents, {
  step,
  client,
  config,
  interaction,
  signal,
  log,
  markSubmissionStarted,
} = {}) {
  if (!page || page.isClosed?.()) {
    throw new AutomationError('BROWSER_CLOSED', '浏览器页面已关闭，无法在页面内上传材料');
  }
  const navigationMs = config?.timeouts?.navigationMs ?? 30000;
  const uploadMs = config?.timeouts?.uploadMs ?? 60000;
  const readyMs = config?.timeouts?.readyMs ?? 20000;

  const terminalOrNonDocState = await waitForDocUploadContainer(page, {
    step, client, interaction, timeoutMs: readyMs, navigationMs, signal, log,
  });
  if (terminalOrNonDocState) return terminalOrNonDocState;
  await attachDocuments(page, documents, { signal, log });

  const submitButton = page.locator(SUBMIT_BUTTON_SELECTOR).first();
  const readyToSubmit = await waitForSubmitEnabled(submitButton, { timeoutMs: 8000, signal });
  if (!readyToSubmit) {
    throw new AutomationError('BROWSER_DOC_SUBMIT_DISABLED', '文档上传提交按钮未变为可点击状态');
  }

  let completeHttpStatus = null;
  let docUploadHttpStatus = null;
  let stepResponseState = null;
  const onResponse = async response => {
    try {
      const url = response.url?.() ?? '';
      const method = response.request?.().method?.() ?? '';
      if (method === 'POST' && url.includes('/step/completeDocUpload')) {
        completeHttpStatus = response.status();
        const body = await response.json().catch(() => null);
        if (body?.currentStep) stepResponseState = body;
      } else if (method === 'POST' && url.includes('/step/docUpload')) {
        docUploadHttpStatus = response.status();
      }
    } catch {
      // Best-effort network observer; status polling confirms final state.
    }
  };
  page.on?.('response', onResponse);
  try {
    await interaction?.beforeSubmit?.();
    await submitButton.scrollIntoViewIfNeeded?.().catch(() => {});
    await markSubmissionStarted?.();
    if (interaction?.click) await interaction.click(submitButton, { timeout: config?.timeouts?.actionMs ?? 10000 });
    else await submitButton.click({ timeout: config?.timeouts?.actionMs ?? 10000 });

    const deadline = Date.now() + Math.max(uploadMs, 30000);
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (stepResponseState) break;
      const stillOnUpload = await page.locator(DOC_UPLOAD_STEP_SELECTOR).first().isVisible().catch(() => false);
      if (!stillOnUpload) break;
      if (completeHttpStatus !== null && completeHttpStatus >= 400) break;
      if (docUploadHttpStatus !== null && docUploadHttpStatus >= 400) break;
      await delay(350, undefined, { signal });
    }
  } finally {
    page.off?.('response', onResponse);
    page.removeListener?.('response', onResponse);
  }

  const failedStatus = completeHttpStatus >= 400 ? completeHttpStatus
    : docUploadHttpStatus >= 400 ? docUploadHttpStatus
      : null;
  if (failedStatus !== null) {
    const error = new AutomationError('BROWSER_DOC_UPLOAD_FAILED',
      `页面上传材料提交失败（HTTP ${failedStatus}）`);
    error.httpStatus = failedStatus;
    throw error;
  }

  // Brief settle delay before querying the authoritative verification state.
  await delay(300, undefined, { signal });
  const { state } = await client.getStatus();
  return state;
}
