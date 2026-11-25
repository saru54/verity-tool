import { browserProxy } from '../core/network.js';
import { connectSession as connectShardBrowser } from './shardbrowser.js';
import { AutomationError } from '../core/errors.js';

// Keep the owned browser session alive without polling or an arbitrary time limit.
export function waitForSessionClose({ browser, context, page }, signal) {
  return new Promise(resolve => {
    const finish = () => {
      browser.removeListener('disconnected', finish);
      context.removeListener('close', finish);
      page.removeListener('close', finish);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    browser.once('disconnected', finish);
    context.once('close', finish);
    page.once('close', finish);
    signal?.addEventListener('abort', finish, { once: true });
    // Check after subscribing so a close/abort between setup steps cannot be missed.
    if (signal?.aborted || !browser.isConnected() || page.isClosed()) finish();
  });
}

async function connectCamoufox(config, { log = () => {} } = {}) {
  const { Camoufox, NewContext, DefaultAddons } = await import('camoufox');
  const proxy = browserProxy();

  const locale = config.browser.locale ?? 'en-US';

  log('browser_launch_started', {
    stage: 'launch', engine: 'camoufox', headless: config.browser.headless,
    proxy: proxy ? 'configured' : 'direct',
  });

  // ── Camoufox launch options (matching original project configuration) ──
  //
  // The original sheeridVerify project ran on the same Linux server with this
  // exact set of options and was not flagged by Cloudflare Turnstile. The key
  // principle: let Camoufox auto-detect the host environment and generate a
  // consistent fingerprint via its built-in fpgen. Do not force an OS identity,
  // do not add anti-detection flags that create detectable contradictions.
  //
  // fingerprint_preset: false — synthetic fpgen, consistent with host env.
  // humanize: 1.5 — numeric humanization level.
  // exclude_addons: [DefaultAddons.UBO] — UBO blocks Cloudflare Turnstile scripts.
  // geoip: true — derives timezone/WebRTC IP from proxy exit.
  // No `os`, no `disable_coop`, no `i_know_what_im_doing`.
  const browser = await Camoufox({
    headless: config.browser.headless,
    locale,
    persistent_context: false,
    fingerprint_preset: false,
    humanize: 1.5,
    exclude_addons: [DefaultAddons.UBO],
    proxy,
    geoip: true,
  });
  try {
    const context = await NewContext(browser, {
      locale,
      ...(config.browser.headless ? {} : { viewport: null, deviceScaleFactor: undefined }),
    });
    context.setDefaultTimeout(config.timeouts.actionMs);
    context.setDefaultNavigationTimeout(config.timeouts.navigationMs);
    const page = await context.newPage();
    log('browser_launch_completed', { stage: 'launch', engine: 'camoufox', actionTimeout: config.timeouts.actionMs, navTimeout: config.timeouts.navigationMs });
    return { browser, context, page, close: () => browser.close(), meta: { engine: 'camoufox' } };
  } catch (error) {
    log('browser_launch_failed', { stage: 'launch', engine: 'camoufox', code: error.code ?? 'CAMOUFOX_ERROR', message: error.message });
    await browser.close().catch(() => {});
    throw error;
  }
}

export async function createSession(config, { log = () => {}, signal } = {}) {
  const engine = config.browser.engine ?? 'camoufox';
  log('session_engine_selected', { stage: 'launch', engine, headless: config.browser.headless, keepOpen: config.browser.keepOpen, autoFill: config.browser.autoFill });
  if (engine === 'camoufox') return connectCamoufox(config, { log, signal });
  log('session_engine_selected', { stage: 'launch', engine: 'shardbrowser', endpoint: config.shardBrowser?.endpoint });
  return connectShardBrowser({ config, log, signal });
}
