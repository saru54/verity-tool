import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { firefox } from 'playwright-core';
import { listInstalled } from 'camoufox';
import { createWebServer } from '../src/web/server.js';
import { createLogger } from '../src/core/logger.js';
import { webConfig } from './fixtures/web-config.js';
import { AutomationError } from '../src/core/errors.js';

const installed = listInstalled().find(item => item.isActive);
const binary = process.platform === 'win32' ? 'camoufox.exe' : process.platform === 'darwin' ? '../MacOS/camoufox' : 'camoufox-bin';
const executablePath = installed && join(installed.path, binary);

test('Web UI deletes failed jobs, allows resubmission and preserves a different selection during deletion', {
  skip: executablePath && existsSync(executablePath) ? false : 'No installed Camoufox for local UI fixture', timeout: 120000,
}, async t => {
  const { configFile } = await webConfig(t);
  let attempts = 0;
  const app = createWebServer({ port: 0, configFile, users: [{ username: 'ops', password: 'ui-pass-1234' }],
    workflow: async (config, { signal }) => {
    if (config.data.firstName === 'Running') {
      await new Promise(resolveDone => signal.addEventListener('abort', resolveDone, { once: true }));
      return { status: 'cancelled' };
    }
    attempts++;
    throw new AutomationError('API_NETWORK_ERROR', '接口请求失败');
  } });
  const origin = await app.start();
  t.after(() => app.close());
  const browser = await firefox.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  // The workspace redirects unauthenticated users to the separate login page.
  await page.waitForFunction(() => window.location.pathname === '/login');
  await page.waitForSelector('#login-username');
  await page.locator('#login-username').fill('ops');
  await page.locator('#login-password').fill('ui-pass-1234');
  await page.locator('#login-submit').click();
  await page.waitForFunction(() => window.location.pathname === '/');
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('已连接'));
  const id = 'dddddddddddddddddddddddd';
  const url = `https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=${id}`;
  await page.locator('[name=url]').fill(url);
  await page.locator('[name=firstName]').fill('NetworkFixture');
  await page.locator('[name=lastName]').fill('Student');
  await page.locator('[name=birthDate]').fill('2000-01-02');
  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '执行失败');
  assert.equal(await page.locator('#delete').isVisible(), true);
  const firstJobId = await page.locator('#selected-job').innerText();
  const firstPath = `${origin}/api/jobs/${firstJobId}`;
  await page.route(firstPath, route => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: { message: '请等待资源清理完成后再删除' } }) }));
  await page.locator('#delete').click();
  await page.waitForFunction(() => document.querySelector('#form-error').textContent.includes('清理完成'));
  assert.equal(app.jobs.jobs.has(firstJobId), true, 'a rejected deletion keeps the task');
  await page.unroute(firstPath);
  await page.locator('#delete').click();
  await page.waitForFunction(() => document.querySelectorAll('#jobs button').length === 0
    && document.querySelector('#job-state').textContent === '待开始');
  assert.equal(await page.locator('#selected-job').innerText(), '');
  assert.equal(await page.locator('#log-count').innerText(), '0 条');
  assert.equal(await page.locator('#logs .empty').count(), 1);
  assert.equal(await page.locator('#delete').isVisible(), false);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('one-selected-job')), null);
  assert.equal(await page.locator('[name=url]').inputValue(), url);
  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '执行失败');
  assert.equal(attempts, 2, 'the same verification ID runs again after explicit deletion');
  const secondJobId = await page.locator('#selected-job').innerText();
  assert.notEqual(secondJobId, firstJobId, 'each submission gets a distinct random task ID');
  // Resubmitting via the left form ("加入队列") creates a fresh task and resets logs.
  await page.locator('#start').click();
  await page.waitForFunction(prevId => !document.querySelector('#form-notice').hidden
    && document.querySelector('#selected-job').textContent !== prevId
    && document.querySelector('#job-state').textContent === '执行失败'
    && document.querySelector('#logs').textContent.includes('状态查询失败')
    && document.querySelector('#log-count').textContent !== '0 条', secondJobId);
  assert.equal(attempts, 3, 'resubmitting via the form creates a new task and executes again');
  const thirdJobId = await page.locator('#selected-job').innerText();
  await page.locator(`[data-job-id="${secondJobId}"]`).click();
  await page.locator('#delete').click();
  await page.waitForFunction(() => document.querySelectorAll('#jobs button').length === 1);
  await mkdir(resolve('.runs/web-preview'), { recursive: true });
  await page.screenshot({ path: resolve('.runs/web-preview/delete-failed-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  const runningId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const runningSnap = await app.jobs.start({ url: url.replace(id, runningId), firstName: 'Running', lastName: 'Student', birthDate: '2000-01-02' });
  const runningJobId = runningSnap.id;
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#jobs button').length === 2);
  const deleting = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const thirdPath = `${origin}/api/jobs/${thirdJobId}`;
  await page.route(thirdPath, async route => { deleting.resolve(); await release.promise; await route.continue(); });
  // Select the finished failed task explicitly: the running task must not be deleted.
  await page.locator(`[data-job-id="${thirdJobId}"]`).click();
  await page.waitForFunction(() => document.querySelector('#delete') && !document.querySelector('#delete').hidden);
  await page.locator('#delete').click();
  await deleting.promise;
  assert.equal(await page.locator('#delete').isDisabled(), true);
  await page.locator(`[data-job-id="${runningJobId}"]`).click();
  release.resolve();
  await page.waitForFunction(() => document.querySelectorAll('#jobs button').length === 1);
  assert.equal(await page.locator('#selected-job').innerText(), runningJobId);
  assert.equal(await page.locator('#delete').isVisible(), false);
  assert.equal(app.jobs.get(runningJobId).job.state, 'running');
  await page.locator('#cancel').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '已停止');
  await page.locator('#delete').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '待开始');
  assert.equal(app.jobs.jobs.size, 0);
  assert.deepEqual(errors, []);
});

test('Web UI queues multiple IDs, reconnects and stops only the selected task', {
  skip: executablePath && existsSync(executablePath) ? false : 'No installed Camoufox for local UI fixture', timeout: 120000,
}, async t => {
  let received;
  const { configFile } = await webConfig(t);
  const app = createWebServer({ port: 0, configFile, users: [{ username: 'ops', password: 'ui-pass-1234' }],
    workflow: async (config, { signal }) => {
    received = config;
    const log = createLogger('ui-fixture');
    if (config.data.firstName === 'NetworkFixture') {
      log('stage_started', { stage: 'preflight' });
      log('status_query_retry', { stage: 'preflight', code: 'API_NETWORK_ERROR' });
      log('status_query_retry', { stage: 'preflight', code: 'API_NETWORK_ERROR' });
      throw new AutomationError('API_NETWORK_ERROR', '接口请求失败');
    }
    log('stage_started', { stage: 'launch' });
    log('stage_started', { stage: 'wait_ready' });
    log('stage_started', { stage: 'fill' });
    for (let i = 0; i < 100; i++) log('interaction_delay', { stage: 'type', field: 'input' });
    log('field_filled', { stage: 'fill', field: 'email' });
    log('stage_started', { stage: 'submit' });
    log('submit_ready', { stage: 'wait_submit', code: 'BUTTON_CLICKABLE' });
    log('stage_started', { stage: 'document' });
    log('stage_started', { stage: 'read_document' });
    log('stage_started', { stage: 'upload_bytes' });
    log('stage_completed', { stage: 'upload_bytes' });
    log('stage_started', { stage: 'complete_upload' });
    for (let i = 0; i < 3; i++) log('waiting_for_review', { stage: 'wait_review', currentStep: 'pending' });
    const outcome = { status: 'failed', code: 'VERIFICATION_UNAVAILABLE', message: '无法继续验证' };
    log('run_finished', outcome);
    log('run_finished', outcome);
    log('browser_kept_open', { stage: 'await_user_close' });
    await new Promise(resolveDone => signal.addEventListener('abort', resolveDone, { once: true }));
    return outcome;
  } });
  const origin = await app.start();
  t.after(() => app.close());
  const browser = await firefox.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1360, height: 1100 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  const reads = [];
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/jobs')) reads.push(request.url());
  });
  async function expectIdle() {
    await page.waitForFunction(() => document.querySelector('#queue-summary').textContent === '运行 0 / 1 · 等待 0');
    // Allow the final log read to settle, then observe several former poll cycles.
    await page.waitForTimeout(1200);
    const count = reads.length;
    await page.waitForTimeout(2200);
    assert.equal(reads.length, count, 'idle pages must stop automatic requests');
  }
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.location.pathname === '/login');
  await page.waitForSelector('#login-username');
  await page.locator('#login-username').fill('ops');
  await page.locator('#login-password').fill('ui-pass-1234');
  await page.locator('#login-submit').click();
  await page.waitForFunction(() => window.location.pathname === '/');
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('已连接'));
  assert.equal(app.jobs.jobs.size, 0);
  await page.waitForFunction(() => !document.querySelector('#start').disabled);
  await expectIdle();
  assert.equal(await page.locator('[name=firstName]').inputValue(), '');
  assert.deepEqual(await page.locator('#task-form input, #task-form select').evaluateAll(items => items.map(item => item.name)),
    ['url', 'profile', 'proxyProvider', 'countryCode', 'universityId', 'firstName', 'lastName', 'birthDate', '', '', '', '', '', '', '', '', '', '', 'fillOnly', 'keepOpenOnFailure']);
  const url = 'https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=bbbbbbbbbbbbbbbbbbbbbbbb';
  await page.locator('[name=url]').fill(url);
  await page.locator('[name=firstName]').fill('Test');
  await page.locator('[name=lastName]').fill('Student');
  await page.locator('[name=birthDate]').fill('2000-01-02');
  await mkdir(resolve('.runs/web-preview'), { recursive: true });
  await page.screenshot({ path: resolve('.runs/web-preview/desktop.png'), fullPage: true });
  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#logs').textContent.includes('验证失败'));
  assert.equal(await page.locator('.status-box, #stage, #outcome, #result-detail').count(), 0);
  assert.doesNotMatch(await page.locator('#logs').innerText(), /interaction_delay|field_filled|VERIFICATION_UNAVAILABLE|wait_submit|启动浏览器|等待页面就绪|无法继续验证/);
  // material_ready arrives before web_queued (identity is generated at submission).
  assert.deepEqual(await page.locator('#logs li').evaluateAll(items => items.map(item => item.lastChild.textContent)),
    ['验证材料已生成', '已加入队列', '检查当前状态', '准备中', '填写资料中', '提交资料中', '等待上传文件', '文件已上传', '等待审核', '验证失败']);
  assert.equal(await page.locator('#logs li').filter({ hasText: '验证失败' }).count(), 1);
  const visibleLogCount = await page.locator('#logs li').count();
  assert.ok(visibleLogCount <= 10);
  assert.equal(await page.locator('#log-count').innerText(), `${visibleLogCount} 条`);
  // The organisation is the generated US university; the email uses its domain.
  assert.match(received.data.organization.optionText, /University|Institute|College/);
  assert.equal(received.data.country, 'United States');
  assert.equal(received.data.organization.emailDomain, received.data.organization.emailDomain.toLowerCase());
  assert.equal(received.data.birthDate, '2000-01-02');
  assert.equal(received.data.email, `test.student@${received.data.organization.emailDomain}`);
  const job1Id = await page.locator('#selected-job').innerText();
  const material = app.jobs.get(job1Id).job.material;
  assert.ok(material.identity.studentNumber.length >= 6);
  assert.deepEqual(material.files.map(file => file.name).sort(),
    ['enrollment-certificate.pdf', 'term-verification.pdf']);
  await page.waitForFunction(() => document.querySelectorAll('#materials .material-card').length >= 1);
  assert.equal(await page.locator('#materials .material-id-value').first().innerText(), job1Id);
  assert.match(await page.locator('#materials .material-sub-id').first().innerText(), /SheerID: bbbbbbbbbbbbbbbbbbbbbbbb/);
  assert.equal(await page.locator('#materials .material-url-link').first().getAttribute('href'), url);
  assert.match(await page.locator('#materials .material-info-list').first().innerText(), /Test Student（手动填写）/);
  assert.equal(received.proxy.server, 'http://127.0.0.1:7777');
  assert.equal(await page.locator('[name=url]').isDisabled(), false);
  await page.locator('[name=url]').fill(url.replace('bbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccc'));
  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '排队中');
  await page.waitForFunction(() => document.querySelectorAll('#jobs button').length === 2);
  const job2Id = await page.locator('#selected-job').innerText();
  await page.screenshot({ path: resolve('.runs/web-preview/desktop.png'), fullPage: true });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '排队中');
  await page.locator('#cancel').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '已停止');
  assert.equal(app.jobs.get(job1Id).job.state, 'running');
  assert.equal(app.jobs.get(job2Id).job.startedAt, null);
  await page.waitForTimeout(1200);
  const stoppedReads = reads.filter(u => u.includes(`/${job2Id}?`)).length;
  const queueReads = reads.filter(u => u.endsWith('/api/jobs')).length;
  await page.waitForTimeout(2200);
  assert.equal(reads.filter(u => u.includes(`/${job2Id}?`)).length, stoppedReads);
  assert.ok(reads.filter(u => u.endsWith('/api/jobs')).length > queueReads, 'other active tasks still update');
  await page.locator('#resume').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '排队中');
  assert.equal(await page.locator('#resume').isVisible(), false);
  assert.equal(app.jobs.jobs.size, 2);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '排队中');
  await page.locator('#cancel').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '已停止');
  assert.equal(await page.locator('#resume').isVisible(), true);
  assert.match(await page.locator('#logs').innerText(), /任务已恢复/);
  await page.locator(`[data-job-id="${job1Id}"]`).click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '运行中');
  await page.locator('#cancel').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '已停止');
  assert.equal(app.jobs.running.size, 0);
  await expectIdle();
  await page.locator('#resume').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '运行中');
  await page.waitForFunction(() => [...document.querySelectorAll('#logs li')].filter(li => li.textContent.includes('验证失败')).length === 2);
  await page.locator('#cancel').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === '已停止');
  await expectIdle();
  await page.locator(`[data-job-id="${job2Id}"]`).click();
  await page.waitForFunction(() => document.querySelector('#logs').textContent.includes('任务已恢复'));
  await expectIdle();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve('.runs/web-preview/mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('[type=reset]').click();
  assert.equal(await page.locator('[name=url]').inputValue(), '');
  await page.locator('[name=url]').fill(url.replace('bbbbbbbbbbbbbbbbbbbbbbbb', 'dddddddddddddddddddddddd'));
  await page.locator('[name=firstName]').fill('NetworkFixture');
  await page.locator('[name=lastName]').fill('Student');
  await page.locator('[name=birthDate]').fill('2000-01-02');
  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#logs').textContent.includes('状态查询失败，请检查网络或代理'));
  assert.doesNotMatch(await page.locator('#logs').innerText(), /验证失败|API_NETWORK_ERROR/);
  assert.equal(await page.locator('#logs li').filter({ hasText: '状态查询暂时失败，正在重试' }).count(), 1);
  await expectIdle();
  assert.deepEqual(errors, []);
});
