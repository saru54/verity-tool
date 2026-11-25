import { AutomationError, requireValue } from '../../core/errors.js';
import { checkKeys } from '../../core/config.js';
import { visibleField, setField, waitForFields, selectChoice } from '../../browser/form.js';
import { selectors as defaults } from './selectors.js';
import { checkVerificationStatus, stepStatuses } from './status.js';
import { formLocales } from './labels.js';
import { waitForSubmitReady } from './human-verification.js';
import { verificationFailure, assertVerificationAvailable } from './page-state.js';
import { forceEnglishForm, formIsEnglish } from './language.js';
import { verificationIdFromUrl } from './client.js';
import { getProfile } from './profiles/index.js';
import { uploadDocumentsInBrowser } from './browser-upload.js';
import { setTimeout as delay } from 'node:timers/promises';

export const sheerid = {
  validate(config) {
    const url = new URL(config.url);
    requireValue(url.origin === 'https://services.sheerid.com' && /^\/verify\/[a-f\d]{24}\/?$/i.test(url.pathname), 'SheerID URL 的域名或项目路径不正确');
    const vid = url.searchParams.get('verificationId');
    requireValue(vid !== null && /^[a-f\d]{24}$/i.test(vid), '请使用包含有效 ?verificationId= 的完整验证链接');
  },

  preflight: checkVerificationStatus,
  failureOutcome: ({ page }) => verificationFailure(page),
  uploadDocuments: ({ page, config, interaction, signal, log }, documents, uploadContext) =>
    uploadDocumentsInBrowser(page, documents, { ...uploadContext, config, interaction, signal, log }),

  validateInput(config) {
    checkKeys(config.data, ['firstName', 'lastName', 'email', 'birthDate', 'organization', 'country', 'consent',
      'emailDomain', 'universityId', 'countryCode'], 'data');
    for (const name of ['firstName', 'lastName', 'email']) {
      requireValue(typeof config.data[name] === 'string' && config.data[name].trim().length > 0, `请填写 data.${name}`);
    }
    requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.data.email), 'email 格式无效');
    const date = config.data.birthDate;
    requireValue(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date), 'birthDate 必须是 YYYY-MM-DD');
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    requireValue(Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date && timestamp < Date.now() && Number(date.slice(0, 4)) >= 1900, 'birthDate 不是有效的出生日期');
    checkKeys(config.data.organization, ['name', 'optionText', 'emailDomain'], 'organization');
    for (const key of ['name', 'optionText']) {
      requireValue(typeof config.data.organization[key] === 'string' && config.data.organization[key].trim().length > 0, `请填写 organization.${key}`);
    }
    requireValue(typeof config.data.country === 'string' && config.data.country.trim().length > 0,
      '请填写 data.country（学校所在国家，例如 United States）；此页面必须先选国家才能搜索学校');
    requireValue(config.data.consent === undefined || typeof config.data.consent === 'boolean', 'consent 必须是布尔值');
    checkKeys(config.selectors, Object.keys(defaults), 'selectors');
    for (const list of Object.values(config.selectors)) {
      requireValue(Array.isArray(list) && list.length > 0 && list.every(value => typeof value === 'string' && value.trim().length > 0), '每个选择器配置必须是非空字符串数组');
    }
  },

  identity(config) {
    return `sheerid:${verificationIdFromUrl(config.url)}`;
  },

  async waitUntilReady({ page, config, signal, log }) {
    const loadBudget = Math.min(15000, config.timeouts.readyMs);
    await page.waitForLoadState('load', { timeout: loadBudget }).catch(error => {
      if (error.name !== 'TimeoutError') throw error;
      log('page_load_slow', { stage: 'wait_ready', code: 'LOAD_EVENT_PENDING', waitedMs: loadBudget });
    });
    signal?.throwIfAborted();
    log('page_loaded', { stage: 'wait_ready', url: page.url(), code: 'DOMCONTENTLOADED' });
    const langResult = await forceEnglishForm(page, { log, signal, timeoutMs: Math.min(30000, config.timeouts.readyMs) });
    log('language_check', { stage: 'wait_ready', switched: langResult.switched, reason: langResult.reason });
    const selectors = { ...defaults, ...config.selectors };
    const profile = getProfile(config.profile);
    // SheerID forms are progressive: only the initial fields are visible at load.
    // The profile declares which fields to wait for; fill() handles the rest.
    const waitFields = profile.readyFields.filter(f => Boolean(selectors[f]));
    log('fields_expected', { stage: 'wait_ready', profile: profile.key, fields: waitFields, note: 'initial fields only (progressive form)', timeoutMs: config.timeouts.readyMs });
    await waitForFields(page, selectors, waitFields, {
      timeoutMs: config.timeouts.readyMs, signal, settleMs: 1000,
      assertPage: () => formPageAvailable(page, config),
      enabledOnly: ['country', 'birthMonth', 'studentStatus'],
      onPending: pendingFields => log('waiting_for_fields', { stage: 'wait_ready', pendingFields, selectors: pendingFields.map(f => selectors[f]) }),
    });
    log('form_ready', { stage: 'wait_ready' });
  },

  async fill({ page, config, signal, log, interaction }) {
    assertSession(page, config);
    await assertFormAvailable(page, config);
    const selectors = { ...defaults, ...config.selectors };
    const profile = getProfile(config.profile);
    const data = config.data;
    // Shared helpers — each profile calls these in its own step order.
    const field = async name => {
      log('field_started', { stage: 'fill', field: name });
      await interaction.beforeField(name);
      await waitForFields(page, selectors, [name], {
        timeoutMs: config.timeouts.readyMs, signal, settleMs: 300,
        assertPage: () => formPageAvailable(page, config),
        enabledOnly: ['country', 'birthMonth', 'studentStatus'],
        onPending: pendingFields => log('waiting_for_fields', { stage: 'fill', field: name, pendingFields }),
      });
      return visibleField(page, selectors[name], name, config.timeouts.actionMs);
    };
    const set = async (name, value) => {
      await setField(await field(name), value, { timeoutMs: config.timeouts.readyMs, signal, interaction });
      log('field_filled', { stage: 'fill', field: name });
    };
    const choose = async (name, options) => {
      await selectChoice(await field(name), {
        ...options, timeoutMs: config.timeouts.readyMs, signal, field: name, interaction,
        assertReady: () => assertFormAvailable(page, config),
        onPending: code => log('waiting_for_options', { stage: 'fill', field: name, code }),
      });
      log('field_filled', { stage: 'fill', field: name });
    };
    // Belt and braces: re-assert English before the first choice.
    if (!await formIsEnglish(page)) {
      await forceEnglishForm(page, { log, signal, timeoutMs: 20000 });
    }
    const locales = await formLocales(page, config.browser.locale);
    log('form_locales', { stage: 'fill', locales, profile: profile.key });
    log('fill_plan', { stage: 'fill', profile: profile.key });
    // Delegate to the profile's own fill sequence.
    await profile.fill({ page, data, selectors, field, set, choose, locales, log, config, interaction });
    // Trigger natural blur via Tab if a text input remains focused after the last field.
    const textInputFocused = await page.evaluate(() => {
      const el = document.activeElement;
      return el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit'].includes(el.type);
    }).catch(() => false);
    if (textInputFocused) {
      await interaction?.settle?.();
      await page.keyboard.press('Tab').catch(() => {});
    }
    log('fill_completed', { stage: 'fill' });
  },

  async submit({ page, config, markSubmissionAttempted, interaction, signal, log }) {
    await assertFormAvailable(page, config);
    await interaction.beforeSubmit();
    const selectors = { ...defaults, ...config.selectors };
    const button = await visibleField(page, selectors.submit, 'submit', config.timeouts.actionMs);
    const valid = await button.evaluate(element => !element.form || element.form.checkValidity());
    if (!valid) throw new AutomationError('FORM_INVALID', '表单存在未填写或无效的必填字段');
    const readiness = await waitForSubmitReady({ page, button, config, interaction, signal, log,
      assertReady: () => assertFormAvailable(page, config) });
    if (readiness === 'STEP_ADVANCED') {
      return { status: 'submission_unknown', code: 'STEP_ADVANCED_DURING_WAIT' };
    }
    await assertFormAvailable(page, config);
    const stillValid = await button.evaluate(element => !element.form || element.form.checkValidity());
    if (!stillValid) throw new AutomationError('FORM_INVALID', '等待验证期间表单数据发生变化或失效，请检查页面必填字段');
    const verificationId = verificationIdFromUrl(config.url);
    const stepName = config.program?.step ?? 'collectStudentPersonalInfo';
    // Arm the response listener before clicking; only observe this session's submission POST.
    let receivedResponse;
    const onResponse = response => {
      const url = new URL(response.url());
      if (url.origin === 'https://services.sheerid.com'
        && url.pathname === `/rest/v2/verification/${verificationId}/step/${stepName}`
        && response.request().method() === 'POST') receivedResponse = response;
    };
    page.on('response', onResponse);
    try {
      await assertFormAvailable(page, config);
      await markSubmissionAttempted();
      try {
        if (interaction?.click) await interaction.click(button);
        else await button.click();
      } catch {
        // An explicit failure page resolves an otherwise uncertain click outcome.
        return await verificationFailure(page)
          ?? { status: 'submission_unknown', code: 'CLICK_OUTCOME_UNKNOWN' };
      }
      const deadline = Date.now() + config.timeouts.resultMs;
      while (true) {
        signal?.throwIfAborted();
        const failure = await verificationFailure(page);
        if (failure) return failure;
        if (receivedResponse || page.isClosed() || Date.now() >= deadline) break;
        await delay(Math.min(200, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
    } finally {
      page.removeListener('response', onResponse);
    }
    const response = receivedResponse;
    if (!response) return { status: 'submission_unknown', code: 'RESULT_TIMEOUT' };
    let body;
    try { body = await response.json(); } catch {
      return { status: 'submission_unknown', code: 'INVALID_RESPONSE' };
    }
    if (!response.ok()) {
      return response.status() >= 400 && response.status() < 500
        ? { status: 'rejected', code: 'HTTP_CLIENT_ERROR' }
        : { status: 'submission_unknown', code: 'HTTP_SERVER_ERROR' };
    }
    if (Array.isArray(body?.errorIds) && body.errorIds.length > 0) {
      return { status: 'validation_failed', code: 'SERVER_VALIDATION_ERROR' };
    }
    const known = typeof body?.currentStep === 'string' && Object.hasOwn(stepStatuses, body.currentStep);
    return { status: known ? stepStatuses[body.currentStep] : 'submission_unknown',
      code: known ? 'STEP_RECEIVED' : 'UNRECOGNIZED_STEP' };
  },
};

function isExpectedSession(page, config) {
  const current = new URL(page.url());
  const expected = new URL(config.url);
  return current.origin === expected.origin
    && current.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '')
    && verificationIdFromUrl(page.url()) === verificationIdFromUrl(config.url);
}

function assertSession(page, config) {
  if (!isExpectedSession(page, config)) {
    throw new AutomationError('UNEXPECTED_PAGE', '页面已离开指定验证会话，已停止表单操作');
  }
}

async function formPageAvailable(page, config) {
  await assertVerificationAvailable(page);
  if (!isExpectedSession(page, config)) return false;
  return true;
}

async function assertFormAvailable(page, config) {
  if (!await formPageAvailable(page, config)) assertSession(page, config);
}
