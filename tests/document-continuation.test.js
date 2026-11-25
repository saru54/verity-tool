import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, withTaskLock } from '../src/core/storage.js';

const verificationId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const bytes = Buffer.from('89504e470d0a1a0a746573742d66697874757265', 'hex');
const materialUrl = 'http://localhost:3000/test-fixture.png?page=2';
let scenario;

// Exercise the real routing, HTTP client, document workflow and disk locks.
// Only the browser and remote responses are simulated; no real verification is contacted.
mock.module('../src/apps/registry.js', { namedExports: { getApplication: () => ({
  validate() {},
  identity: () => `sheerid:${verificationId}`,
  preflight: async () => ({ proceed: true, currentStep: 'collectStudentPersonalInfo', errorIds: [] }),
  validateInput() {},
  waitUntilReady: async () => {},
  fill: async () => { scenario.events.push('fill'); },
  submit: async ({ markSubmissionAttempted }) => {
    await markSubmissionAttempted();
    scenario.events.push('browser_submit');
    scenario.step = scenario.nextStep ?? 'docUpload';
    return { status: scenario.browserStatus ?? 'document_required', code: 'STEP_RECEIVED' };
  },
  failureOutcome: async () => scenario.pageFailure ?? null,
}) } });
mock.module('../src/core/logger.js', { namedExports: { createLogger: () => () => {} } });
mock.module('../src/browser/session.js', { namedExports: {
  createSession: async () => {
    scenario.events.push('launch');
    let closed = false;
    return {
      browser: { isConnected: () => !closed }, context: {},
      page: { isClosed: () => closed, goto: async () => ({ ok: () => true, status: () => 200 }) },
      close: async () => { closed = true; scenario.closedAt.push(scenario.step); scenario.events.push('close'); },
    };
  },
  waitForSessionClose: async () => {
    scenario.events.push('wait_for_close');
    await assert.rejects(acquireLock(scenario.directory, `sheerid:${verificationId}`), { code: 'TASK_LOCKED' });
  },
} });
const { runWorkflow } = await import('../src/core/workflow.js');

async function cleanDirectory(directory) {
  await rm(directory, { recursive: true, force: true });
}

async function runCase(settings = {}, options = { submit: true }, assertions = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'one-document-test-'));
  scenario = { events: [], requests: [], observations: [], closedAt: [], step: 'collectStudentPersonalInfo', directory, ...settings };
  const config = {
    app: 'sheerid', profile: 'google-one', proxy: settings.proxy ?? null, artifactsDir: directory,
    url: `https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=${verificationId}`,
    browser: { headless: settings.headless ?? false, keepOpen: settings.keepOpen ?? true,
      keepOpenOnFailure: settings.keepOpenOnFailure ?? false, autoFill: settings.autoFill ?? true },
    document: { url: materialUrl },
    data: settings.data,
    interaction: { keyDelayMs: { min: 0, max: 0 }, fieldDelayMs: { min: 0, max: 0 }, submitDelayMs: { min: 0, max: 0 } },
    timeouts: { apiMs: 1000, downloadMs: 1000, uploadMs: 1000 },
    polling: { intervalMs: 1 },
  };
  const response = extra => new Response(JSON.stringify({
    verificationId, currentStep: scenario.step, errorIds: scenario.errorIds ?? [], ...extra,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fetchMock = mock.method(globalThis, 'fetch', async (input, request = {}) => {
    const url = new URL(input);
    const method = request.method ?? 'GET';
    scenario.requests.push({ method, url: url.href });
    if (settings.proxy && url.hostname !== 'localhost') assert.ok(request.dispatcher);
    if (request.dispatcher) {
      scenario.dispatcher ??= request.dispatcher;
      assert.equal(request.dispatcher, scenario.dispatcher);
    }
    if (url.hostname === 'localhost') {
      await assert.rejects(acquireLock(directory, `sheerid:${verificationId}`), { code: 'TASK_LOCKED' });
      if (!settings.keepOpenOnFailure && scenario.events.includes('launch') && scenario.step === 'docUpload') assert.ok(scenario.events.includes('close'));
      scenario.events.push('download');
      return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
    }
    if (url.hostname === 'test.s3.amazonaws.com') {
      assert.equal(method, 'PUT');
      assert.deepEqual(Buffer.from(request.body), bytes);
      scenario.events.push('upload');
      if (scenario.failUpload) throw new Error('Simulated lost upload response');
      return new Response(null, { status: 200 });
    }
    assert.equal(url.origin, 'https://my.sheerid.com');
    assert.ok(url.pathname.startsWith(`/rest/v2/verification/${verificationId}`));
    if (method === 'GET') {
      if (scenario.events.includes('browser_submit') && scenario.afterSubmitSteps?.length) {
        const next = scenario.afterSubmitSteps.shift();
        scenario.observations.push({ step: next, closed: scenario.events.includes('close') });
        if (next instanceof Response) return next;
        scenario.step = next;
      } else {
        if (scenario.events.includes('complete_upload') || ['pending', 'emailLoop'].includes(scenario.step)) scenario.step = 'success';
        scenario.observations.push({ step: scenario.step, closed: scenario.events.includes('close') });
      }
      if (scenario.events.includes('browser_submit')) settings.cancelAfterSubmitQuery?.();
      if (scenario.failUpload && scenario.events.includes('upload')) { scenario.step = 'error'; scenario.errorIds = ['docReviewLimitExceeded']; }
      return response();
    }
    if (method === 'DELETE' && url.pathname.endsWith('/step/sso')) {
      scenario.events.push('cancel_sso');
      scenario.step = 'docUpload';
      return response();
    }
    if (method === 'POST' && url.pathname.endsWith('/step/docUpload')) {
      scenario.events.push('initiate_upload');
      assert.equal(JSON.parse(request.body).files[0].fileSize, bytes.length);
      return response({ documents: [{ mimeType: 'image/png', fileSize: bytes.length,
        uploadUrl: 'https://test.s3.amazonaws.com/document' }] });
    }
    if (method === 'POST' && url.pathname.endsWith('/step/completeDocUpload')) {
      scenario.events.push('complete_upload');
      scenario.step = 'pending';
      return response();
    }
    throw new Error(`Unexpected mock request: ${method} ${url.pathname}`);
  });
  try {
    const result = await runWorkflow(config, options);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.lock')), false);
    await assertions(result, scenario);
  } finally {
    fetchMock.mock.restore();
    await cleanDirectory(directory);
  }
}

test('browser closes before document download and the task lock stays held through upload', async () => {
  await runCase({}, { submit: true }, (result, state) => {
    assert.equal(result.status, 'verified');
    assert.equal(result.browserOpened, true);
    assert.equal(result.submissionAttempted, true);
    assert.ok(result.documentRunId);
    assert.equal(result.documentStage, 'query_status');
    assert.deepEqual(state.events, ['launch', 'fill', 'browser_submit', 'close', 'download',
      'initiate_upload', 'upload', 'complete_upload']);
  });
});

test('closing the browser preserves the shared proxy dispatcher for document requests', async () => {
  await runCase({ proxy: 'http://127.0.0.1:1' }, { submit: true }, (result, state) => {
    assert.equal(result.status, 'verified');
    assert.ok(state.dispatcher);
    assert.equal(state.events.filter(event => event === 'close').length, 1);
    assert.equal(state.events.includes('wait_for_close'), false);
  });
});

test('SSO continuation reads the file before switching to document review', async () => {
  await runCase({ nextStep: 'sso', browserStatus: 'sso_required' }, { submit: true }, (result, state) => {
    assert.equal(result.status, 'verified');
    assert.ok(state.events.indexOf('cancel_sso') < state.events.indexOf('close'));
    assert.ok(state.events.indexOf('close') < state.events.indexOf('initiate_upload'));
    assert.deepEqual(state.closedAt, ['docUpload']);
    assert.ok(state.events.indexOf('download') < state.events.indexOf('cancel_sso'));
    assert.equal(state.events.filter(event => event === 'complete_upload').length, 1);
  });
});

test('continuation rechecks server state and does not upload if verification already succeeded', async () => {
  await runCase({ nextStep: 'success' }, { submit: true }, (result, state) => {
    assert.equal(result.status, 'verified');
    assert.equal(state.requests.every(request => request.method === 'GET'), true);
    assert.equal(state.events.includes('download'), false);
    assert.equal(state.events.includes('wait_for_close'), false);
  });
});

test('terminal browser outcomes never start uploads', async () => {
  for (const browserStatus of ['failed', 'rejected', 'verified']) {
    await runCase({ browserStatus }, { submit: true }, (result, state) => {
      assert.equal(result.status, browserStatus === 'rejected' ? 'failed' : browserStatus);
      assert.equal(state.events.includes('download'), false);
      assert.equal(state.requests.length, 1);
    });
  }
});

test('browser pending and email outcomes keep the browser until a terminal result', async () => {
  for (const [browserStatus, nextStep] of [['pending', 'pending'], ['email_required', 'emailLoop']]) {
    await runCase({ browserStatus, nextStep }, { submit: true }, (result, state) => {
      assert.equal(result.status, 'verified');
      assert.equal(state.events.includes('wait_for_close'), false);
      assert.equal(state.events.includes('download'), false);
      assert.equal(state.events.filter(event => event === 'close').length, 1);
      assert.deepEqual(state.closedAt, ['success']);
      assert.ok(state.observations.every(item => !item.closed));
    });
  }
});

test('submission waits for API docUpload before closing, even when the page already shows upload', async () => {
  for (const browserStatus of ['document_required', 'submission_unknown']) {
    await runCase({ browserStatus, afterSubmitSteps: ['collectStudentPersonalInfo', 'collectStudentPersonalInfo', 'docUpload'] },
      { submit: true }, (result, state) => {
        assert.equal(result.status, 'verified');
        assert.ok(state.observations.slice(0, 4).every(item => !item.closed));
        assert.deepEqual(state.closedAt, ['docUpload']);
        assert.equal(state.events.filter(event => event === 'browser_submit').length, 1);
        assert.ok(state.events.indexOf('close') < state.events.indexOf('download'));
      });
  }
});

test('intermediate review/email steps and temporary API errors do not close the browser', async () => {
  await runCase({ browserStatus: 'submission_unknown', afterSubmitSteps: [
    new Response(null, { status: 503 }), 'pending', 'emailLoop', 'docUpload',
  ] }, { submit: true }, (result, state) => {
    assert.equal(result.status, 'verified');
    assert.ok(state.observations.slice(0, 5).every(item => !item.closed));
    assert.deepEqual(state.closedAt, ['docUpload']);
    assert.equal(state.events.filter(event => event === 'browser_submit').length, 1);
  });
});

test('terminal API rejection closes for cleanup without uploading', async () => {
  await runCase({ afterSubmitSteps: ['error'] }, { submit: true }, (result, state) => {
    assert.equal(result.status, 'failed');
    assert.deepEqual(state.closedAt, ['error']);
    assert.equal(state.events.includes('download'), false);
    assert.ok(state.observations.every(item => !item.closed));
  });
});

test('stopping before the API reaches upload closes the browser and releases resources', async () => {
  const controller = new AbortController();
  await runCase({ afterSubmitSteps: ['collectStudentPersonalInfo'], cancelAfterSubmitQuery: () => controller.abort() },
    { submit: true, signal: controller.signal }, (result, state) => {
      assert.equal(result.code, 'CANCELLED');
      assert.ok(state.events.includes('close'));
      assert.equal(state.events.includes('download'), false);
      assert.equal(state.events.filter(event => event === 'browser_submit').length, 1);
    });
});

test('an uncertain browser submit checks the API before continuing material upload', async () => {
  await runCase({ browserStatus: 'submission_unknown' }, { submit: true }, (result, state) => {
    assert.equal(result.status, 'verified');
    assert.equal(state.events.filter(event => event === 'browser_submit').length, 1);
    assert.equal(state.events.filter(event => event === 'upload').length, 1);
    assert.equal(state.events.includes('wait_for_close'), false);
  });
});

test('fill-only mode never submits or starts document processing and keeps headed browser open', async () => {
  await runCase({ headless: false, keepOpen: false }, { submit: false }, (result, state) => {
    assert.equal(result.status, 'filled');
    assert.equal(state.events.includes('browser_submit'), false);
    assert.equal(state.events.includes('download'), false);
    assert.ok(state.events.includes('wait_for_close'));
  });
});

test('keepOpenOnFailure keeps browser open through docUpload handoff until user closes', async () => {
  await runCase({ keepOpenOnFailure: true, keepOpen: false }, { submit: true }, (result, state) => {
    assert.equal(result.status, 'verified');
    assert.ok(state.events.includes('upload'));
    assert.ok(state.events.includes('wait_for_close'));
    assert.ok(state.events.indexOf('upload') < state.events.indexOf('wait_for_close'));
    assert.ok(state.events.indexOf('wait_for_close') < state.events.indexOf('close'));
  });
});

test('lost upload response is queried until a terminal rejection and is never replayed', async () => {
  await runCase({ failUpload: true }, { submit: true }, (result, state) => {
    assert.equal(result.status, 'failed');
    assert.equal(state.events.filter(event => event === 'upload').length, 1);
    assert.equal(state.events.includes('complete_upload'), false);
  });
});

test('an existing document step can upload with automatic form filling disabled', async () => {
  await runCase({ step: 'docUpload', autoFill: false }, { submit: true }, (result, state) => {
    assert.equal(result.status, 'verified');
    assert.equal(result.browserOpened, false);
    assert.equal(state.events.includes('launch'), false);
  });
});

test('nested task locks retain exclusion and release after an exception', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'one-lock-test-'));
  try {
    await assert.rejects(withTaskLock(directory, 'same-task', async () => {
      await withTaskLock(directory, 'same-task', async () => {});
      await assert.rejects(acquireLock(directory, 'same-task'), { code: 'TASK_LOCKED' });
      throw new Error('test failure');
    }), /test failure/);
    const release = await acquireLock(directory, 'same-task');
    await release();
    assert.deepEqual(await readdir(directory), []);
  } finally { await cleanDirectory(directory); }
});
