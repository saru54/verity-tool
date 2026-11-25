import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadDocumentsInBrowser } from '../src/apps/sheerid/browser-upload.js';
import { waitForSubmitReady } from '../src/apps/sheerid/human-verification.js';
import { runDocumentWorkflow } from '../src/apps/sheerid/document-workflow.js';
import { normalizeConfig } from '../src/core/config.js';
import { buildIdentityBundle, buildMaterialFiles, loadUniversities, materialSummary } from '../src/materials/index.js';

function createFakeDocUploadPage({ singleFirstInput = false, startOnSso = false, directSsoCancel = false } = {}) {
  const emitter = new EventEmitter();
  const ctxEmitter = new EventEmitter();
  const staged = [];
  let submitted = false;
  let onSso = startOnSso;
  let ssoActive = directSsoCancel;
  let popupClosed = 0;

  const makeLocator = selector => {
    const loc = {
      first: () => loc,
      filter: () => loc,
      count: async () => {
        if (selector.includes('#sid-step-sso') && !selector.includes('button')) return onSso ? 1 : 0;
        if (selector.includes('.sid-sso-pending-submit-btn')) return onSso && ssoActive ? 1 : 0;
        if (selector.includes('#sid-submit-btn-sso')) return onSso && !ssoActive ? 1 : 0;
        if (selector.includes('#sid-step-doc-upload') && !selector.includes('input')) return (!onSso && !submitted) ? 1 : 0;
        if (selector.includes('.sid-docdrop-wrap__dropzone')) return (!onSso && staged.length === 0) ? 1 : 0;
        if (selector.includes('sid-take-photo-input')) return (!onSso && staged.length > 0) ? 1 : 0;
        if (selector.includes('input[type="file"]')) return (!onSso && !submitted) ? 1 : 0;
        if (selector.includes('.sid-file-list__remove-btn')) return 0;
        if (selector.includes('.sid-file-list__name')) return staged.length;
        // Simulate SheerID's extra "Add documents" .sid-file-list__file tile when >0 files staged.
        if (selector.includes('.sid-file-list__file')) return staged.length + (staged.length > 0 && staged.length < 3 ? 1 : 0);
        if (selector.includes('#sid-submit-doc-upload')) return (!onSso && !submitted) ? 1 : 0;
        return 0;
      },
      waitFor: async ({ state } = {}) => {
        if (state === 'visible' && selector.includes('#sid-step-doc-upload') && onSso) {
          throw new Error('still on sso');
        }
        if (state === 'visible' && selector.includes('.sid-sso-pending-submit-btn') && (!onSso || !ssoActive)) {
          throw new Error('cancel btn hidden');
        }
        if (state === 'visible' && selector.includes('#sid-submit-btn-sso') && (!onSso || ssoActive)) {
          throw new Error('login btn hidden');
        }
      },
      isVisible: async () => {
        const wantsDoc = selector.includes('#sid-step-doc-upload');
        const wantsSso = selector.includes('#sid-step-sso');
        if (wantsDoc && wantsSso) return (!onSso && !submitted) || onSso;
        if (wantsSso) return onSso;
        if (wantsDoc) return !onSso && !submitted;
        return !submitted;
      },
      isDisabled: async () => false,
      getAttribute: async attr => (attr === 'aria-disabled' ? (staged.length > 0 ? 'false' : 'true') : null),
      scrollIntoViewIfNeeded: async () => {},
      hover: async () => {},
      setInputFiles: async input => {
        const items = Array.isArray(input) ? input : [input];
        if (singleFirstInput && staged.length === 0 && items.length > 1) {
          staged.push(items[0]);
        } else {
          staged.push(...items);
        }
      },
      allTextContents: async () => staged.map(item => item.name),
      click: async () => {
        if (selector.includes('#sid-submit-btn-sso')) {
          ssoActive = true;
          ctxEmitter.emit('page', { close: async () => { popupClosed += 1; } });
          return;
        }
        if (selector.includes('.sid-sso-pending-submit-btn')) {
          onSso = false;
          return;
        }
        submitted = true;
        emitter.emit('response', {
          url: () => 'https://my.sheerid.com/rest/v2/verification/aaaaaaaaaaaaaaaaaaaaaaaa/step/completeDocUpload',
          request: () => ({ method: () => 'POST' }),
          status: () => 200,
          json: async () => ({ verificationId: 'aaaaaaaaaaaaaaaaaaaaaaaa', currentStep: 'pending' }),
        });
      },
    };
    return loc;
  };

  return {
    isClosed: () => false,
    locator: selector => makeLocator(selector),
    getByText: () => makeLocator('text'),
    getByRole: () => makeLocator('role'),
    context: () => ctxEmitter,
    on: (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
    removeListener: (ev, fn) => emitter.removeListener(ev, fn),
    reload: async () => {},
    staged,
    get popupClosed() { return popupClosed; },
  };
}

test('uploadDocumentsInBrowser attaches all PDFs at once and submits via #sid-submit-doc-upload', async () => {
  const page = createFakeDocUploadPage();
  let marked = false;
  const docs = [
    { fileName: '123456.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.7 a') },
    { fileName: '654321.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.7 b') },
  ];
  const state = await uploadDocumentsInBrowser(page, docs, {
    client: {
      getStatus: async () => ({ state: { verificationId: 'aaaaaaaaaaaaaaaaaaaaaaaa', currentStep: 'pending', errorIds: [], rejectionReasons: [] } }),
    },
    markSubmissionStarted: async () => { marked = true; },
  });

  assert.equal(marked, true);
  assert.equal(state.currentStep, 'pending');
  assert.deepEqual(page.staged.map(d => d.name), ['123456.pdf', '654321.pdf']);
});

test('uploadDocumentsInBrowser falls back to #sid-take-photo-input when initial dropzone accepts one file', async () => {
  const page = createFakeDocUploadPage({ singleFirstInput: true });
  const docs = [
    { fileName: '111222.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.7 a') },
    { fileName: '333444.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.7 b') },
  ];
  const state = await uploadDocumentsInBrowser(page, docs, {
    client: {
      getStatus: async () => ({ state: { verificationId: 'aaaaaaaaaaaaaaaaaaaaaaaa', currentStep: 'pending', errorIds: [], rejectionReasons: [] } }),
    },
  });

  assert.equal(state.currentStep, 'pending');
  assert.deepEqual(page.staged.map(d => d.name), ['111222.pdf', '333444.pdf']);
});

test('uploadDocumentsInBrowser skips SSO via page cancel button (direct & after login click) and uploads both PDFs', async () => {
  const docs = [
    { fileName: '555666.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.7 a') },
    { fileName: '777888.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.7 b') },
  ];

  // Case A: direct inline cancel-SSO button ("Upload Proof of Enrollment") is visible.
  const directPage = createFakeDocUploadPage({ startOnSso: true, directSsoCancel: true });
  const directState = await uploadDocumentsInBrowser(directPage, docs, {
    step: 'sso',
    client: {
      getStatus: async () => ({ state: { verificationId: 'aaaaaaaaaaaaaaaaaaaaaaaa', currentStep: 'pending', errorIds: [], rejectionReasons: [] } }),
    },
  });
  assert.equal(directState.currentStep, 'pending');
  assert.deepEqual(directPage.staged.map(d => d.name), ['555666.pdf', '777888.pdf']);

  // Case B: cancel button reveals after clicking #sid-submit-btn-sso; popup tab is auto-closed.
  const twoStepPage = createFakeDocUploadPage({ startOnSso: true, directSsoCancel: false });
  const twoStepState = await uploadDocumentsInBrowser(twoStepPage, docs, {
    step: 'sso',
    client: {
      getStatus: async () => ({ state: { verificationId: 'aaaaaaaaaaaaaaaaaaaaaaaa', currentStep: 'pending', errorIds: [], rejectionReasons: [] } }),
    },
  });
  assert.equal(twoStepState.currentStep, 'pending');
  assert.equal(twoStepPage.popupClosed, 1);
  assert.deepEqual(twoStepPage.staged.map(d => d.name), ['555666.pdf', '777888.pdf']);
});

test('waitForSubmitReady returns STEP_ADVANCED when browser transitions to #sid-step-doc-upload', async () => {
  const page = createFakeDocUploadPage({ startOnSso: false });
  const readiness = await waitForSubmitReady({
    page,
    button: { isEnabled: async () => false },
    config: { timeouts: { humanMs: 1000 } },
    log: () => {},
    assertReady: async () => {},
  });
  assert.equal(readiness, 'STEP_ADVANCED');
});

test('runDocumentWorkflow keeps browser open and uploads both renamed PDFs in-page across retries', async t => {
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const workDir = await mkdtemp(join(tmpdir(), 'sheerid-browser-upload-wf-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const taskDir = join(workDir, id);
  const artifactsDir = join(workDir, 'artifacts');
  await mkdir(taskDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  const universities = await loadUniversities('us');
  const identity = buildIdentityBundle({ seed: id, university: universities[0] });
  const files = buildMaterialFiles(identity);
  for (const file of files) {
    await writeFile(join(taskDir, file.name), file.bytes);
  }
  await writeFile(join(taskDir, 'material.json'), JSON.stringify({
    verificationId: id,
    summary: materialSummary(identity, files),
  }, null, 2));

  let statusCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    statusCalls += 1;
    if (statusCalls === 1) {
      return new Response(JSON.stringify({ verificationId: id, currentStep: 'docUpload', errorIds: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ verificationId: id, currentStep: 'success', errorIds: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  });

  const config = await normalizeConfig({
    app: 'sheerid',
    url: `https://services.sheerid.com/verify/${id}/?verificationId=${id}`,
    artifactsDir,
    document: { path: join(taskDir, files[0].name) },
    polling: { reviewDelayMs: { min: 0, max: 0 } },
  }, {});

  let closedForHandoff = false;
  const uploadedBatches = [];
  const result = await runDocumentWorkflow(config, {
    submit: true,
    beforeDocumentUpload: async () => { closedForHandoff = true; },
    browserUpload: async (documents, { markSubmissionStarted }) => {
      await markSubmissionStarted();
      uploadedBatches.push(documents.map(doc => ({ name: doc.fileName, size: doc.fileSize, mime: doc.mimeType })));
      return { verificationId: id, currentStep: 'pending', errorIds: [], rejectionReasons: [] };
    },
  });

  assert.equal(closedForHandoff, false, 'live browser must not close for handoff when browserUpload runs');
  assert.equal(result.status, 'verified');
  assert.equal(uploadedBatches.length, 1);
  assert.equal(uploadedBatches[0].length, 2);
  assert.match(uploadedBatches[0][0].name, /^\d{6,8}\.pdf$/);
  assert.match(uploadedBatches[0][1].name, /^\d{6,8}\.pdf$/);
  assert.notEqual(uploadedBatches[0][0].name, uploadedBatches[0][1].name);
  assert.equal(uploadedBatches[0][0].size, files[0].bytes.length);
  assert.equal(uploadedBatches[0][1].size, files[1].bytes.length);
});
