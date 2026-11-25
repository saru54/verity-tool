import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AutomationError, requireValue } from './errors.js';
import { resolveProxy, normalizeDataImpulseConfig, normalizeNodeMavenConfig } from './proxy.js';
import { normalizeIpQualityConfig } from './ip-quality.js';
import { resolveShardBrowserSettings } from './shardbrowser-config.js';

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function checkKeys(value, allowed, label) {
  requireValue(isRecord(value), `${label} 必须是对象`);
  requireValue(Object.keys(value).every(key => allowed.includes(key)), `${label} 包含不支持的配置项`);
}

export function normalizeWebConfig(value = {}) {
  checkKeys(value, ['concurrency'], 'web');
  const concurrency = value.concurrency ?? 1;
  requireValue(Number.isSafeInteger(concurrency) && concurrency >= 1,
    'web.concurrency 必须是大于等于 1 的整数');
  return { concurrency };
}

function timeout(value, fallback, label) {
  const result = value ?? fallback;
  requireValue(Number.isInteger(result) && result >= 1000 && result <= 300000,
    `${label} 必须是 1000–300000 毫秒的整数`);
  return result;
}

function delayRange(value, fallback, label, limit) {
  const range = value ?? fallback;
  checkKeys(range, ['min', 'max'], label);
  requireValue(Number.isInteger(range.min) && Number.isInteger(range.max)
    && range.min >= 0 && range.max >= range.min && range.max <= limit,
    `${label} 必须满足 0 <= min <= max <= ${limit}（毫秒整数）`);
  return { min: range.min, max: range.max };
}

export async function loadConfig(filename, env = process.env) {
  let text;
  try {
    text = await readFile(resolve(filename), 'utf8');
  } catch (cause) {
    throw new AutomationError(cause.code === 'ENOENT' ? 'CONFIG_MISSING' : 'INVALID_CONFIG',
      cause.code === 'ENOENT'
        ? `配置文件不存在：${resolve(filename)}；请复制 config/sheerid.example.json 为该路径（Web 模式会自动生成）`
        : `配置文件无法读取：${resolve(filename)}`, { cause });
  }
  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (cause) {
    throw new AutomationError('INVALID_CONFIG',
      `配置文件不是有效 JSON：${resolve(filename)}（不支持注释和尾随逗号）`, { cause });
  }
  return normalizeConfig(raw, env);
}

// Both the CLI file loader and the local Web form use the same validation.
export async function normalizeConfig(raw, env = process.env) {
  checkKeys(raw, ['app', 'url', 'profile', 'proxy', 'proxyProvider', 'nodemaven', 'dataimpulse', 'browser', 'shardBrowser', 'materials', 'timeouts', 'interaction',
    'document', 'data', 'selectors', 'artifactsDir', 'web', 'polling', 'emailDomain', 'ipQuality'], '配置');
  const web = normalizeWebConfig(raw.web);
  const polling = raw.polling ?? {};
  const rawDomain = raw.data?.organization?.emailDomain ?? raw.emailDomain ?? raw.data?.emailDomain;
  requireValue(rawDomain === undefined || typeof rawDomain === 'string', 'emailDomain 必须是字符串');
  const emailDomain = typeof rawDomain === 'string' ? rawDomain.trim().replace(/^@+/, '') : '';
  if (emailDomain) {
    requireValue(/^[^\s@]+\.[^\s@]+$/.test(emailDomain), 'emailDomain 格式无效，必须如 xxx.edu');
  }
  checkKeys(polling, ['intervalMs', 'reviewDelayMs'], 'polling');
  const intervalMs = timeout(polling.intervalMs, 5000, 'polling.intervalMs');
  const reviewDelayMs = delayRange(polling.reviewDelayMs, { min: 10000, max: 20000 }, 'polling.reviewDelayMs', 300000);
  requireValue(typeof raw.app === 'string' && /^[a-z][a-z0-9-]*$/.test(raw.app), 'app 格式无效');
  const browser = raw.browser ?? {};
  const shardBrowser = raw.shardBrowser ?? {};
  const materials = raw.materials ?? {};
  const timeouts = raw.timeouts ?? {};
  const interaction = raw.interaction ?? {};
  const document = raw.document ?? {};
  checkKeys(document, ['path', 'url'], 'document');
  requireValue(document.path === undefined || typeof document.path === 'string', 'document.path 必须是本地路径字符串');
  requireValue(document.url === undefined || typeof document.url === 'string', 'document.url 必须是网络地址字符串');
  requireValue(!(document.path?.trim() && document.url?.trim()), 'document.path 与 document.url 只能填写一个');
  checkKeys(interaction, ['keyDelayMs', 'fieldDelayMs', 'submitDelayMs'], 'interaction');
  checkKeys(browser, ['engine', 'headless', 'locale', 'keepOpen', 'autoFill', 'fingerprintId', 'platform', 'keepOpenOnFailure'], 'browser');
  checkKeys(shardBrowser, ['endpoint', 'token', 'platform', 'timeoutMs', 'configFile', 'language'], 'shardBrowser');
  checkKeys(materials, ['enabled', 'reuse', 'kind'], 'materials');
  checkKeys(timeouts, ['apiMs', 'downloadMs', 'uploadMs', 'actionMs', 'navigationMs', 'readyMs', 'humanMs', 'resultMs'], 'timeouts');
  const engine = browser.engine ?? 'camoufox';
  requireValue(['shardbrowser', 'camoufox'].includes(engine), 'browser.engine 仅支持 shardbrowser 或 camoufox');
  // Credentials come from the repository-root shardbrowser.json by default; the
  // main config and then the environment may override individual values.
  const shardBrowserSettings = await resolveShardBrowserSettings(raw, env);
  requireValue((shardBrowser.platform ?? browser.platform ?? 'Windows') === 'Windows',
    'ShardBrowser 平台固定为 Windows（高校材料面向桌面端）');
  requireValue(typeof shardBrowser.token === 'string' || shardBrowser.token === undefined,
    'shardBrowser.token 必须是字符串');
  requireValue(shardBrowser.configFile === undefined || typeof shardBrowser.configFile === 'string',
    'shardBrowser.configFile 必须是字符串');
  requireValue(browser.fingerprintId === undefined || typeof browser.fingerprintId === 'string', 'browser.fingerprintId 必须是字符串');
  requireValue(browser.headless === undefined || typeof browser.headless === 'boolean', 'headless 必须是布尔值');
  requireValue(browser.keepOpen === undefined || typeof browser.keepOpen === 'boolean', 'keepOpen 必须是布尔值');
  requireValue(browser.autoFill === undefined || typeof browser.autoFill === 'boolean', 'autoFill 必须是布尔值');
  requireValue(browser.autoFill !== false || (browser.headless !== true && browser.keepOpen !== false),
    '手动填写模式需要 headless: false，并保持 keepOpen: true');
  requireValue(browser.keepOpenOnFailure === undefined || typeof browser.keepOpenOnFailure === 'boolean', 'keepOpenOnFailure 必须是布尔值');
  requireValue(!(browser.headless === true && browser.keepOpen === true), '无界面模式不能设置 keepOpen: true');
  requireValue(browser.locale === undefined || (typeof browser.locale === 'string' && browser.locale.length > 0), 'locale 格式无效');
  requireValue(materials.enabled === undefined || typeof materials.enabled === 'boolean', 'materials.enabled 必须是布尔值');
  requireValue(materials.reuse === undefined || typeof materials.reuse === 'boolean', 'materials.reuse 必须是布尔值');
  const materialKind = materials.kind ?? 'enrollment';
  requireValue(['enrollment', 'studentCard', 'semester'].includes(materialKind), 'materials.kind 仅支持 enrollment、studentCard 或 semester');
  requireValue(raw.artifactsDir === undefined || (typeof raw.artifactsDir === 'string' && raw.artifactsDir.length > 0), 'artifactsDir 格式无效');
  let url;
  try { url = new URL(env.AUTOMATION_URL || raw.url); } catch {
    throw new AutomationError('INVALID_CONFIG', 'url 或 AUTOMATION_URL 必须是有效 URL');
  }
  requireValue(url.protocol === 'https:' && !url.username && !url.password, '仅支持无嵌入凭据的 HTTPS URL');
  const proxyProvider = raw.proxyProvider === undefined || raw.proxyProvider === null || String(raw.proxyProvider).trim() === ''
    ? undefined
    : String(raw.proxyProvider).trim().toLowerCase();
  if (proxyProvider !== undefined) {
    requireValue(['nodemaven', 'dataimpulse', 'direct'].includes(proxyProvider), 'proxyProvider 仅支持 nodemaven、dataimpulse 或 direct');
  }
  const nodemaven = normalizeNodeMavenConfig(raw.nodemaven);
  const dataimpulse = normalizeDataImpulseConfig(raw.dataimpulse);
  const ipQuality = normalizeIpQualityConfig(raw.ipQuality);
  return {
    app: raw.app, url: url.href, profile: raw.profile ?? 'google-one', data: raw.data, selectors: raw.selectors ?? {}, web, polling: { intervalMs, reviewDelayMs }, emailDomain,
    // An empty AUTOMATION_PROXY falls back to the config file instead of forcing a value.
    proxy: await resolveProxy(env.AUTOMATION_PROXY?.trim() ? env.AUTOMATION_PROXY : raw.proxy, env),
    proxyProvider,
    nodemaven,
    dataimpulse,
    ipQuality,
    document: { path: document.path ?? '', url: document.url ?? '' },
    browser: {
      engine,
      headless: browser.headless ?? false,
      locale: browser.locale ?? 'en-US',
      keepOpen: browser.keepOpen ?? !(browser.headless ?? false),
      autoFill: browser.autoFill ?? true,
      fingerprintId: browser.fingerprintId ?? '',
      keepOpenOnFailure: browser.keepOpenOnFailure ?? false,
    },
    shardBrowser: {
      endpoint: shardBrowserSettings.endpoint,
      token: shardBrowserSettings.token,
      platform: 'Windows',
      // "en-US" forces an English browser fingerprint (timezone stays IP-driven);
      // "auto" keeps the launcher's IP-derived language.
      language: shardBrowserSettings.language === 'auto' ? 'auto' : 'en-US',
      timeoutMs: shardBrowserSettings.timeoutMs,
      configFile: shardBrowserSettings.file,
      tokenSource: shardBrowserSettings.tokenSource,
    },
    materials: { enabled: materials.enabled ?? true, reuse: false, kind: materialKind },
    timeouts: {
      apiMs: timeout(timeouts.apiMs, 20000, 'apiMs'),
      downloadMs: timeout(timeouts.downloadMs, 120000, 'downloadMs'),
      uploadMs: timeout(timeouts.uploadMs, 120000, 'uploadMs'),
      actionMs: timeout(timeouts.actionMs, 15000, 'actionMs'),
      navigationMs: timeout(timeouts.navigationMs, 60000, 'navigationMs'),
      readyMs: timeout(timeouts.readyMs, 120000, 'readyMs'),
      humanMs: timeout(timeouts.humanMs, 180000, 'humanMs'),
      resultMs: timeout(timeouts.resultMs, 45000, 'resultMs'),
    },
    interaction: {
      keyDelayMs: delayRange(interaction.keyDelayMs, { min: 40, max: 120 }, 'keyDelayMs', 1000),
      fieldDelayMs: delayRange(interaction.fieldDelayMs, { min: 500, max: 1200 }, 'fieldDelayMs', 10000),
      submitDelayMs: delayRange(interaction.submitDelayMs, { min: 1000, max: 2000 }, 'submitDelayMs', 10000),
    },
    artifactsDir: resolve(raw.artifactsDir ?? '.runs'),
  };
}
