import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { AutomationError, requireValue } from '../core/errors.js';
import { parseProxy } from '../core/proxy.js';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:40325';
// The verification material describes German universities, so the browser must
// always look like a Windows desktop. Timezone and geolocation stay on "auto"
// (IP-following); the browser language is forced to English because the SheerID
// form selects its UI language from the campaign, and the launcher's IP-based
// language would otherwise render Chinese option lists that never match.
const REQUIRED_PLATFORM = 'Windows';
const DEFAULT_LANGUAGE = 'en-US';
const LAPTOP_RESOLUTIONS = ['1280x800', '1366x768', '1536x864', '1600x900', '1920x1080', '1920x1200'];

export function shardBrowserSettings(config = {}) {
  const settings = config.shardBrowser ?? {};
  const browser = config.browser ?? {};
  const endpoint = (settings.endpoint ?? process.env.SHARDBROWSER_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const token = settings.token ?? process.env.SHARDBROWSER_TOKEN ?? process.env.SHARDX_API_TOKEN
    ?? process.env.SHARDBROWSER_API_KEY ?? '';
  const language = String(settings.language ?? DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE;
  return {
    endpoint,
    token: String(token).trim(),
    platform: String(settings.platform ?? REQUIRED_PLATFORM),
    // "auto" keeps the IP-derived language; anything else is forced into the fingerprint.
    language,
    fingerprintId: browser.fingerprintId ?? settings.fingerprintId ?? '',
    headless: browser.headless === true,
    timeoutMs: Number(settings.timeoutMs ?? 20000),
  };
}

export function proxyString(proxy) {
  const parsed = parseProxy(proxy);
  if (!parsed) return '';
  const url = new URL(parsed.server);
  if (parsed.username) {
    url.username = encodeURIComponent(parsed.username);
    url.password = encodeURIComponent(parsed.password);
  }
  return url.href.replace(/\/$/, '');
}

export class ShardBrowserClient {
  constructor({ endpoint = DEFAULT_ENDPOINT, token, timeoutMs = 20000 } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body, { signal, timeoutMs } = {}) {
    const deadline = AbortSignal.timeout(timeoutMs ?? this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try {
      response = await fetch(`${this.endpoint}${path}`, {
        method,
        signal: combined,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (signal?.aborted) throw new AutomationError('CANCELLED', '任务已取消');
      if (deadline.aborted) throw new AutomationError('SHARDBROWSER_TIMEOUT', 'ShardBrowser 本机 API 响应超时');
      throw new AutomationError('SHARDBROWSER_UNREACHABLE',
        `无法连接 ShardBrowser 本机 API（${this.endpoint}）；请确认启动器已运行并开启 API`, { cause: error });
    }
    const text = await response.text().catch(() => '');
    let payload;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (response.status === 401) {
      throw new AutomationError('SHARDBROWSER_UNAUTHORIZED',
        'ShardBrowser API 拒绝了访问密钥；请在启动器“API”页面生成新的 Bearer 密钥并填入配置');
    }
    if (!response.ok) {
      throw new AutomationError('SHARDBROWSER_ERROR',
        `ShardBrowser API ${method} ${path} 返回 ${response.status}${payload?.error ? `：${payload.error}` : ''}`);
    }
    return payload;
  }

  async health({ signal } = {}) {
    return this.request('GET', '/health', null, { signal });
  }

  async fingerprints({ signal } = {}) {
    const list = await this.request('GET', '/fingerprints', null, { signal });
    requireValue(Array.isArray(list), 'ShardBrowser 指纹库响应格式无效');
    return list;
  }

  // The launcher honours a full fingerprint object only on persistent profiles
  // (POST /profiles); /profiles/temporary ignores it and falls back to the
  // library's IP-derived language. Timezone stays "auto" so it still follows
  // the egress IP.
  async createFingerprint({ platform = REQUIRED_PLATFORM, signal } = {}) {
    const generated = await this.request('GET', `/fingerprint/new/${platform}`, null, { signal });
    requireValue(generated?.fingerprint && typeof generated.fingerprint === 'object',
      'ShardBrowser 未返回可定制的指纹模板');
    return generated.fingerprint;
  }

  async createProfile({ name, platform = REQUIRED_PLATFORM, fingerprintId, fingerprint, proxy, signal } = {}) {
    if (fingerprint) {
      // Custom fingerprint: needs a persistent profile; delete after each run.
      const body = { name, fingerprint };
      if (proxy) body.proxy = proxy;
      const profile = await this.request('POST', '/profiles', body, { signal });
      requireValue(profile && typeof profile.id === 'string' && profile.id.length > 0,
        'ShardBrowser 未返回配置标识，未启动浏览器');
      return profile;
    }
    const body = { platform, name };
    if (fingerprintId) body.fingerprint_id = fingerprintId;
    if (proxy) body.proxy = proxy;
    const profile = await this.request('POST', '/profiles/temporary', body, { signal });
    requireValue(profile && typeof profile.id === 'string' && profile.id.length > 0,
      'ShardBrowser 未返回临时配置标识，未启动浏览器');
    return profile;
  }

  async startProfile(id, { headless = false, signal } = {}) {
    const started = await this.request('POST', `/profiles/${id}/start`, { headless: Boolean(headless) }, { signal });
    requireValue(started?.cdp?.web_socket_debugger_url,
      `ShardBrowser 未提供调试连接（${started?.cdp_error ?? '未知原因'}）`);
    return started;
  }

  async stopProfile(id, { signal } = {}) {
    return this.request('POST', `/profiles/${id}/stop`, {}, { signal, timeoutMs: 15000 }).catch(() => null);
  }

  async deleteProfile(id, { signal } = {}) {
    return this.request('DELETE', `/profiles/${id}`, null, { signal, timeoutMs: 15000 }).catch(() => null);
  }

  async runningProfiles({ signal } = {}) {
    const list = await this.request('GET', '/running', null, { signal });
    return Array.isArray(list) ? list : [];
  }
}

// Choose the Windows fingerprint that will back one task. The launcher derives
// timezone and browser language from the profile's egress IP (auto geo), so the
// stored fingerprint locale is irrelevant here; hardware identity is what matters.
export async function chooseFingerprint(client, settings, { signal } = {}) {
  if (settings.fingerprintId) return settings.fingerprintId;
  const profiles = await client.fingerprints({ signal });
  const windows = profiles.filter(entry => entry.platform === REQUIRED_PLATFORM);
  requireValue(windows.length > 0, 'ShardBrowser 指纹库中没有 Windows 平台指纹');
  // A student laptop is the expected device: prefer mobile GPUs, then integrated
  // graphics, and only fall back to the full Windows pool when neither exists.
  const laptop = windows.filter(entry => /Laptop|Notebook/i.test(entry.gpu ?? ''));
  const integrated = windows.filter(entry => /UHD Graphics|HD Graphics|Iris|Vega|Radeon\(TM\) Graphics/i
    .test(entry.gpu ?? ''));
  const pool = laptop.length > 0 ? laptop : integrated.length > 0 ? integrated : windows;
  const index = Math.floor(Math.random() * pool.length);
  return pool[index].id;
}

// Force the fingerprint's browser language (default en-US) while leaving the
// timezone and geolocation on auto so they keep following the egress IP.
export function forceFingerprintLanguage(fingerprint, language = DEFAULT_LANGUAGE) {
  const forced = structuredClone(fingerprint);
  const base = language.split('-')[0];
  forced.timezone = 'auto';
  forced.geolocation = { mode: 'auto' };
  forced.icu_locale = language;
  forced.navigator = {
    ...forced.navigator,
    language,
    languages: [language, base].filter((value, index, list) => list.indexOf(value) === index),
    accept_language: `${language},${base};q=0.9`,
  };
  forced.name = `win-forced-${language.toLowerCase()}-${createHash('sha256')
    .update(`${forced.navigator.user_agent}:${language}`).digest('hex').slice(0, 8)}`;
  return forced;
}

export async function connectSession({ config, log = () => {}, signal } = {}) {
  const settings = shardBrowserSettings(config);
  requireValue(settings.token.length > 0,
    '未配置 ShardBrowser Bearer 密钥：请在项目根目录 shardbrowser.json 填写 token（可复制 shardbrowser.example.json），或用 shardBrowser.token / SHARDBROWSER_TOKEN 提供');
  requireValue(settings.platform === REQUIRED_PLATFORM,
    `验证材料面向美国高校桌面端，ShardBrowser 平台必须固定为 ${REQUIRED_PLATFORM}`);
  log('shardbrowser_settings', {
    stage: 'launch', endpoint: settings.endpoint, platform: settings.platform,
    language: settings.language, tokenSource: config.shardBrowser?.tokenSource ?? 'unknown',
  });
  const client = new ShardBrowserClient({ endpoint: settings.endpoint, token: settings.token, timeoutMs: settings.timeoutMs });
  const health = await client.health({ signal });
  requireValue(health?.ok === true, 'ShardBrowser 本机 API 健康检查失败');
  signal?.throwIfAborted();

  const verificationId = new URL(config.url).searchParams.get('verificationId')
    ?? new URL(config.url).pathname.match(/^\/verify\/([a-f\d]{24})/i)?.[1]
    ?? config.url.split('/').pop();
  const name = `sheerid-${String(verificationId).slice(0, 8)}`;
  const proxy = proxyString(config.proxy);
  let profile;
  let fingerprintId;
  if (settings.language === 'auto') {
    fingerprintId = await chooseFingerprint(client, settings, { signal });
    profile = await client.createProfile({ name, fingerprintId, proxy, signal });
  } else {
    const fingerprint = forceFingerprintLanguage(
      await client.createFingerprint({ platform: settings.platform, signal }), settings.language);
    profile = await client.createProfile({ name, fingerprint, proxy, signal });
    fingerprintId = profile.fingerprint_id ?? fingerprint.name;
  }
  log('shardbrowser_profile_created', {
    stage: 'launch', profileId: profile.id, fingerprintId,
    language: settings.language, proxy: proxy ? 'configured' : 'direct', headless: settings.headless,
  });

  let started;
  try {
    started = await client.startProfile(profile.id, { headless: settings.headless, signal });
  } catch (error) {
    await client.stopProfile(profile.id).catch(() => {});
    await client.deleteProfile(profile.id).catch(() => {});
    throw error;
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(started.cdp.web_socket_debugger_url, { timeout: settings.timeoutMs });
  } catch (error) {
    await client.stopProfile(profile.id).catch(() => {});
    await client.deleteProfile(profile.id).catch(() => {});
    throw new AutomationError('SHARDBROWSER_CDP_FAILED', '无法通过调试端口接管 ShardBrowser 窗口', { cause: error });
  }
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    await client.deleteProfile(profile.id).catch(() => {});
    throw new AutomationError('SHARDBROWSER_CDP_FAILED', 'ShardBrowser 未提供浏览器上下文');
  }
  context.setDefaultTimeout(config.timeouts.actionMs);
  context.setDefaultNavigationTimeout(config.timeouts.navigationMs);
  const page = await context.newPage();
  const meta = {
    engine: 'shardbrowser', endpoint: settings.endpoint, profileId: profile.id,
    fingerprintId: profile.fingerprint_id ?? fingerprintId, cdpPort: started.cdp.port,
    proxy: proxy ? 'configured' : 'direct',
  };
  log('shardbrowser_ready', { stage: 'launch', ...meta });
  const close = async () => {
    await browser.close().catch(() => {});
    await client.stopProfile(profile.id).catch(() => {});
    await client.deleteProfile(profile.id).catch(() => {});
  };
  return { browser, context, page, close, meta, client };
}

export { LAPTOP_RESOLUTIONS, REQUIRED_PLATFORM, DEFAULT_ENDPOINT, DEFAULT_LANGUAGE };
