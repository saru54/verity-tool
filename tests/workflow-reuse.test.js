import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let createSessionCalls = 0;
let bridgeClosed = 0;
let oldPageClosed = 0;
let newPageCreated = 0;
let browserClosed = 0;

const fakeNewPage = {
  goto: async () => ({ status: () => 200, ok: () => true }),
  url: () => 'https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=bbbbbbbbbbbbbbbbbbbbbbbb',
  isClosed: () => false,
  once: () => {},
  removeListener: () => {},
};

const fakeOldPage = {
  close: async () => { oldPageClosed++; },
};

const fakeSession = {
  browser: { isConnected: () => true, once: () => {}, removeListener: () => {}, close: async () => { browserClosed++; } },
  context: {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    newPage: async () => { newPageCreated++; return fakeNewPage; },
    once: () => {},
    removeListener: () => {},
  },
  page: fakeOldPage,
  close: async () => { browserClosed++; },
  meta: { engine: 'camoufox', reused: true },
};

const fakeBridge = {
  browserProxy: { server: 'http://127.0.0.1:49999' },
  server: { on: () => {} },
  close: async () => { bridgeClosed++; },
};

await mock.module('../src/core/ip-quality.js', {
  exports: {
    normalizeIpQualityConfig: v => v ?? { enabled: true, threshold: 70, maxRetries: 5, requireResidential: true, fallbackCountries: ['de'] },
    passesThreshold: () => true,
    ensureIpQuality: async () => ({
      proxy: { server: 'http://gw.dataimpulse.com:10000', username: 'u__cr.de;sessid.s1', password: 'p' },
      score: 91,
      grade: 'A+',
      ip: '9.9.9.9',
      country: 'de',
      sessionId: 's1',
      ipType: 'residential',
      attempts: [{ label: 'retry-4-de', passed: true }],
      bridge: fakeBridge,
      session: fakeSession,
    }),
  },
});

await mock.module('../src/browser/session.js', {
  exports: {
    createSession: async () => { createSessionCalls++; return fakeSession; },
    waitForSessionClose: async () => {},
  },
});

await mock.module('../src/browser/interaction.js', {
  exports: {
    createInteraction: () => ({
      beforeField: async () => {},
      beforeSubmit: async () => {},
      keyDelay: () => 0,
    }),
  },
});

let filledData;
const { uploadDocumentsInBrowser } = await import('../src/apps/sheerid/browser-upload.js');
await mock.module('../src/apps/registry.js', {
  exports: {
    getApplication: () => ({
      validate: () => {},
      identity: () => 'sheerid:bbbbbbbbbbbbbbbbbbbbbbbb',
      preflight: async () => ({ proceed: true, currentStep: 'collectStudentPersonalInfo', errorIds: [] }),
      validateInput: () => {},
      waitUntilReady: async () => {},
      fill: async ({ config }) => { filledData = config.data; },
      submit: async () => ({ status: 'filled', code: 'FORM_FILLED' }),
      failureOutcome: async () => null,
      uploadDocuments: ({ page, config, interaction, signal, log }, documents, uploadContext) =>
        uploadDocumentsInBrowser(page, documents, { ...uploadContext, config, interaction, signal, log }),
    }),
  },
});

const { runWorkflow } = await import('../src/core/workflow.js');

test('runWorkflow selects proxy first, generates matching country materials, and reuses the screened browser without restarting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'one-workflow-reuse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    verificationId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    currentStep: 'collectStudentPersonalInfo',
    errorIds: [],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  t.after(() => fetchMock.mock.restore());

  const config = {
    app: 'sheerid',
    url: 'https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=bbbbbbbbbbbbbbbbbbbbbbbb',
    proxy: null,
    dataimpulse: { host: 'gw.dataimpulse.com', port: 10000, username: 'u', password: 'p' },
    ipQuality: { enabled: true, threshold: 70, maxRetries: 5, requireResidential: true, fallbackCountries: ['de'] },
    materials: { enabled: true, reuse: false, kind: 'enrollment' },
    document: { path: '', url: '' },
    browser: { engine: 'camoufox', headless: false, keepOpen: false, autoFill: true, locale: 'en-US' },
    timeouts: { apiMs: 1000, actionMs: 1000, navigationMs: 1000, readyMs: 1000, downloadMs: 1000, uploadMs: 1000 },
    interaction: { keyDelayMs: { min: 0, max: 0 }, fieldDelayMs: { min: 0, max: 0 }, submitDelayMs: { min: 0, max: 0 } },
    polling: { intervalMs: 10 },
    artifactsDir: directory,
    data: { country: 'United States', countryCode: 'US' },
    selectors: {},
  };

  const result = await runWorkflow(config, { submit: false });
  assert.equal(result.status, 'filled');
  assert.equal(createSessionCalls, 0, 'screened browser was reused without calling createSession');
  assert.equal(newPageCreated, 1, 'clean SheerID tab opened in the same browser');
  assert.equal(oldPageClosed, 1, 'old cleanip.io tab closed');
  assert.equal(browserClosed, 1, 'reused browser closed cleanly on exit');
  assert.equal(bridgeClosed, 1, 'reused proxy bridge closed cleanly on exit');
  assert.equal(filledData.countryCode, 'DE');
  assert.equal(filledData.country, 'Germany');
});

test('resubmitting an existing ?verificationId= already at docUpload uploads its archived PDFs instead of generating a mismatched identity', async t => {
  const { prepareMaterialsForConfig } = await import('../src/core/materials-store.js');
  const { mkdtemp: mk, rm: remove } = await import('node:fs/promises');
  const directory = await mk(join(tmpdir(), 'one-workflow-vid-archive-'));
  t.after(() => remove(directory, { recursive: true, force: true }));

  const vid = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const seedConfig = {
    app: 'sheerid',
    url: `https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=${vid}`,
    artifactsDir: directory,
    document: { path: '', url: '' },
    data: { countryCode: 'DE' },
  };
  const first = await prepareMaterialsForConfig(seedConfig, { verificationId: vid });

  const uploadedBatches = [];
  let statusPolls = 0;
  let slot = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async (resource, opts = {}) => {
    const reqUrl = String(resource);
    const method = (opts.method || 'GET').toUpperCase();
    if (reqUrl.endsWith('/step/docUpload') && method === 'POST') {
      const payload = JSON.parse(opts.body);
      uploadedBatches.push(payload.files);
      return new Response(JSON.stringify({
        verificationId: vid,
        currentStep: 'docUpload',
        errorIds: [],
        documents: payload.files.map(entry => ({
          uploadUrl: `https://s3.us-east-1.amazonaws.com/sheerid-test/vid-${++slot}`,
          mimeType: entry.mimeType,
          fileSize: entry.fileSize,
        })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (reqUrl.startsWith('https://s3.us-east-1.amazonaws.com/')) {
      return new Response('', { status: 200 });
    }
    if (reqUrl.endsWith('/step/completeDocUpload') && method === 'POST') {
      return new Response(JSON.stringify({ verificationId: vid, currentStep: 'pending', errorIds: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    statusPolls += 1;
    const step = statusPolls <= 2 ? 'docUpload' : 'success';
    return new Response(JSON.stringify({ verificationId: vid, currentStep: step, errorIds: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  });
  t.after(() => fetchMock.mock.restore());

  const resumeConfig = {
    app: 'sheerid',
    profile: 'google-one',
    url: `https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=${vid}`,
    proxy: null,
    ipQuality: { enabled: false },
    materials: { enabled: true, reuse: false, kind: 'enrollment' },
    document: { path: '', url: '' },
    // autoFill: false keeps the headless API continuation path without a browser.
    browser: { engine: 'camoufox', headless: true, keepOpen: false, autoFill: false, locale: 'en-US' },
    timeouts: { apiMs: 1000, actionMs: 1000, navigationMs: 1000, readyMs: 1000, downloadMs: 1000, uploadMs: 1000 },
    interaction: { keyDelayMs: { min: 0, max: 0 }, fieldDelayMs: { min: 0, max: 0 }, submitDelayMs: { min: 0, max: 0 } },
    polling: { intervalMs: 1, reviewDelayMs: { min: 0, max: 0 } },
    artifactsDir: directory,
    data: {},
    selectors: {},
  };

  const result = await runWorkflow(resumeConfig, { submit: true });
  assert.equal(result.status, 'verified');
  assert.equal(uploadedBatches.length, 1);
  assert.equal(uploadedBatches[0].length, 2);
  assert.equal(uploadedBatches[0][0].fileSize, first.files[0].bytes.length, 'kept archived primary PDF matching submitted form');
  assert.equal(uploadedBatches[0][1].fileSize, first.files[1].bytes.length, 'kept archived secondary PDF matching submitted form');
  assert.match(uploadedBatches[0][0].fileName, /^\d{6,8}\.pdf$/);
  assert.match(uploadedBatches[0][1].fileName, /^\d{6,8}\.pdf$/);
});

test('resuming ?verificationId= already at docUpload with autoFill enabled opens browser and uploads via DOM', async t => {
  const { prepareMaterialsForConfig } = await import('../src/core/materials-store.js');
  const { mkdtemp: mk, rm: remove } = await import('node:fs/promises');
  const directory = await mk(join(tmpdir(), 'one-workflow-vid-browser-doc-'));
  t.after(() => remove(directory, { recursive: true, force: true }));

  const vid = 'cccccccccccccccccccccccc';
  const priorTaskId = '111111111111111111111111';
  const currentTaskId = '222222222222222222222222';
  const seedConfig = {
    app: 'sheerid',
    url: `https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=${vid}`,
    artifactsDir: directory,
    document: { path: '', url: '' },
    data: { countryCode: 'DE' },
  };
  const archived = await prepareMaterialsForConfig(seedConfig, {
    verificationId: priorTaskId,
    task: { taskId: priorTaskId, sheeridVerificationId: vid },
  });

  // Attach DOM locator support to fakeNewPage and fakeOldPage for browser-doc upload test.
  let docNavigated = false;
  let browserStagedNames = [];
  let docSubmitClicked = false;
  const loc = selector => ({
    first: () => loc(selector),
    count: async () => {
      if (selector.includes('#sid-step-doc-upload') && !selector.includes('input')) return docSubmitClicked ? 0 : 1;
      if (selector.includes('.sid-docdrop-wrap__dropzone')) return browserStagedNames.length === 0 ? 1 : 0;
      if (selector.includes('.sid-file-list__remove-btn')) return 0;
      if (selector.includes('.sid-file-list__name')) return browserStagedNames.length;
      if (selector.includes('#sid-submit-doc-upload')) return docSubmitClicked ? 0 : 1;
      return 1;
    },
    waitFor: async () => {},
    isVisible: async () => !docSubmitClicked,
    isDisabled: async () => false,
    getAttribute: async attr => (attr === 'aria-disabled' ? (browserStagedNames.length > 0 ? 'false' : 'true') : null),
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    setInputFiles: async input => {
      const list = Array.isArray(input) ? input : [input];
      browserStagedNames = list.map(entry => ({ name: entry.name, size: entry.buffer.length }));
    },
    allTextContents: async () => browserStagedNames.map(entry => entry.name),
    click: async () => { docSubmitClicked = true; },
  });
  fakeSession.page = fakeOldPage;
  fakeOldPage.goto = async () => { docNavigated = true; return { status: () => 200, ok: () => true }; };
  fakeOldPage.url = () => `https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=${vid}`;
  fakeOldPage.isClosed = () => false;
  fakeOldPage.once = () => {};
  fakeOldPage.removeListener = () => {};
  fakeOldPage.locator = selector => loc(selector);

  let statusPolls = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    statusPolls += 1;
    const step = statusPolls <= 2 ? 'docUpload' : 'success';
    return new Response(JSON.stringify({ verificationId: vid, currentStep: step, errorIds: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  });
  t.after(() => fetchMock.mock.restore());

  const resumeConfig = {
    app: 'sheerid',
    profile: 'google-one',
    url: `https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=${vid}`,
    proxy: null,
    ipQuality: { enabled: false },
    materials: { enabled: true, reuse: false, kind: 'enrollment' },
    document: { path: '', url: '' },
    browser: { engine: 'camoufox', headless: true, keepOpen: false, autoFill: true, locale: 'en-US' },
    timeouts: { apiMs: 1000, actionMs: 1000, navigationMs: 1000, readyMs: 1000, downloadMs: 1000, uploadMs: 1000 },
    interaction: { keyDelayMs: { min: 0, max: 0 }, fieldDelayMs: { min: 0, max: 0 }, submitDelayMs: { min: 0, max: 0 } },
    polling: { intervalMs: 1, reviewDelayMs: { min: 0, max: 0 } },
    artifactsDir: directory,
    data: {},
    selectors: {},
  };

  const result = await runWorkflow(resumeConfig, { submit: true, jobId: currentTaskId });
  assert.equal(docNavigated, true, 'screened/created browser navigated to the SheerID docUpload page');
  assert.equal(docSubmitClicked, true, 'submitted via browser DOM #sid-submit-doc-upload');
  assert.equal(result.status, 'verified');
  assert.equal(browserStagedNames.length, 2);
  assert.equal(browserStagedNames[0].size, archived.files[0].bytes.length);
  assert.equal(browserStagedNames[1].size, archived.files[1].bytes.length);
  assert.match(browserStagedNames[0].name, /^\d{6,8}\.pdf$/);
  assert.match(browserStagedNames[1].name, /^\d{6,8}\.pdf$/);
  const { readMaterial } = await import('../src/core/materials-store.js');
  const clonedArchive = await readMaterial(directory, currentTaskId);
  assert.ok(clonedArchive, 'new taskId retains its own copied archive record');
  assert.equal(clonedArchive.task.sheeridVerificationId, vid);
  assert.equal(clonedArchive.task.archivedFromTaskId, priorTaskId);
});
