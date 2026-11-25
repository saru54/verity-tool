import { AutomationError, requireValue } from './errors.js';
import { parseProxy, upstreamProxyUrl, resolveDynamicProvider } from './proxy.js';

/**
 * IP quality & availability pre-check via SheerID probe + cleanip.io.
 *
 * Before launching the SheerID verification, each candidate proxy:
 * 1. Runs a fast HTTP availability probe to services.sheerid.com via ProxyAgent
 *    to filter out dead tunnels, 407 auth errors, and DataImpulse 503 NO_RAY
 *    before spending time launching Camoufox.
 * 2. Visits https://cleanip.io/ through Camoufox to extract the purity score
 *    (0–100), proxy/abuse detection flags, and IP type (residential vs datacenter).
 *
 * If availability or quality fails, the proxy is rebuilt with a new sticky
 * session ID and/or a fallback country up to `maxRetries` times.
 */

const CLEANIP_URL = 'https://cleanip.io/';
const AVAILABILITY_URL = 'https://services.sheerid.com/';
const COUNTRY_NAME_TO_CODE = {
  'united states': 'us',
  canada: 'ca',
  'united kingdom': 'gb',
  germany: 'de',
};

// Default config — overridden by config.ipQuality in the run config.
const DEFAULTS = {
  enabled: true,
  threshold: 80,        // minimum purity score to accept the IP
  maxRetries: 5,        // how many times to try a new proxy before giving up
  requireResidential: true,  // reject datacenter-labeled IPs even if score is high
  // cleanip.io's "代理与匿名" (proxy & anonymity) flags detect proxy headers,
  // timing, and other fingerprinting signals. Residential proxy IPs routinely
  // score 1-2/6 here — the IP is real but routed through a proxy gateway.
  // This is expected for DataImpulse and does NOT mean the IP is flagged by
  // SheerID/Cloudflare (which check fraud/reputation, not anonymity headers).
  // Only reject when ALL 6 flags are set (meaning the IP is transparently
  // identifiable as a proxy with no anonymity at all).
  maxProxyFlags: 5,     // reject if proxyFlags >= 6 (transparent proxy, no anonymity)
  maxAbuseFlags: 3,     // reject if abuseFlags > 3 (active abuse reputation)
  fallbackCountries: ['ca', 'de', 'gb', 'fr', 'au'],  // tried when the task's own country fails
};

/**
 * Normalize the ipQuality section from config.
 */
export function normalizeIpQualityConfig(value) {
  if (value === undefined || value === null) return DEFAULTS;
  requireValue(typeof value === 'object' && !Array.isArray(value), 'ipQuality 必须是一个对象');
  requireValue(
    Object.keys(value).every(k => ['enabled', 'threshold', 'maxRetries', 'requireResidential', 'maxProxyFlags', 'maxAbuseFlags', 'fallbackCountries'].includes(k)),
    'ipQuality 包含不支持的配置项',
  );
  const enabled = value.enabled ?? DEFAULTS.enabled;
  requireValue(typeof enabled === 'boolean', 'ipQuality.enabled 必须是布尔值');
  const threshold = value.threshold ?? DEFAULTS.threshold;
  requireValue(Number.isInteger(threshold) && threshold >= 0 && threshold <= 100, 'ipQuality.threshold 必须是 0–100 的整数');
  const maxRetries = value.maxRetries ?? DEFAULTS.maxRetries;
  requireValue(Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 20, 'ipQuality.maxRetries 必须是 0–20 的整数');
  const requireResidential = value.requireResidential ?? DEFAULTS.requireResidential;
  requireValue(typeof requireResidential === 'boolean', 'ipQuality.requireResidential 必须是布尔值');
  const maxProxyFlags = value.maxProxyFlags ?? DEFAULTS.maxProxyFlags;
  requireValue(Number.isInteger(maxProxyFlags) && maxProxyFlags >= 0 && maxProxyFlags <= 6, 'ipQuality.maxProxyFlags 必须是 0–6 的整数');
  const maxAbuseFlags = value.maxAbuseFlags ?? DEFAULTS.maxAbuseFlags;
  requireValue(Number.isInteger(maxAbuseFlags) && maxAbuseFlags >= 0 && maxAbuseFlags <= 6, 'ipQuality.maxAbuseFlags 必须是 0–6 的整数');
  const fallbackCountries = value.fallbackCountries ?? DEFAULTS.fallbackCountries;
  requireValue(Array.isArray(fallbackCountries) && fallbackCountries.every(c => typeof c === 'string' && /^[a-z]{2}$/i.test(c)),
    'ipQuality.fallbackCountries 必须是 ISO 国家代码字符串数组');
  return Object.freeze({ enabled, threshold, maxRetries, requireResidential, maxProxyFlags, maxAbuseFlags, fallbackCountries: fallbackCountries.map(c => c.toLowerCase()) });
}

function closeWithTimeout(browser, ms = 5000) {
  return Promise.race([
    browser.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, ms)),
  ]);
}

function abortSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Fast proxy availability check against SheerID before launching Camoufox.
 * Rejects tunnel errors, proxy auth errors (407), and upstream 5xx (e.g. 503 NO_RAY).
 */
export async function checkProxyAvailability(browserProxy, { timeoutMs = 10000, signal } = {}) {
  const { ProxyAgent } = await import('undici');
  const dispatcher = new ProxyAgent({ uri: browserProxy.server });
  try {
    const response = await fetch(AVAILABILITY_URL, {
      method: 'HEAD',
      dispatcher,
      redirect: 'manual',
      signal: abortSignal(signal, timeoutMs),
    });
    if (response.status === 407 || response.status >= 500) {
      throw new AutomationError('PROXY_UNAVAILABLE', `代理不可用：目标返回 HTTP ${response.status}`);
    }
    return { ok: true, status: response.status };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof AutomationError) throw error;
    throw new AutomationError('PROXY_UNAVAILABLE', `代理连通性检查失败：${error.message}`, { cause: error });
  } finally {
    await dispatcher.destroy().catch(() => {});
  }
}

/**
 * Visit cleanip.io through a camoufox browser (proxied) and extract the real
 * purity score and risk indicators.
 * When keepOpen is true, returns { data, session } without closing the browser.
 */
async function checkCleanipScore(browserProxy, {
  headless = false,
  locale = 'en-US',
  timeoutMs = 30000,
  signal,
  keepOpen = false,
} = {}) {
  signal?.throwIfAborted();
  const { Camoufox, NewContext, DefaultAddons } = await import('camoufox');

  // canvas_noise:false — this browser only checks IP purity, does NOT need canvas
  // stealth. On GPU-less servers, canvas noise makes cleanip.io score the
  // browser itself as suspicious, falsifying IP scores.
  // Use configured headless boolean (never 'virtual', which is Linux-only and
  // creates a 1x1 Xvfb window that degrades cleanip.io scores).
  const browser = await Camoufox({
    headless,
    persistent_context: false,
    fingerprint_preset: false,
    humanize: 1.5,
    exclude_addons: [DefaultAddons.UBO],
    proxy: browserProxy,
    geoip: true,
    locale,
    canvas_noise: false,
  });

  let handoff = false;
  const onAbort = () => { void closeWithTimeout(browser, 2000); };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const context = await NewContext(browser, {
      locale,
      ...(headless ? { viewport: { width: 1366, height: 768 } } : { viewport: null }),
      deviceScaleFactor: undefined,
    });
    context.setDefaultTimeout(timeoutMs);
    context.setDefaultNavigationTimeout(timeoutMs);

    const page = await context.newPage();
    const response = await page.goto(CLEANIP_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!response || !response.ok()) {
      throw new AutomationError('IP_CHECK_NAV_FAILED', `cleanip.io 返回 HTTP ${response?.status() ?? 'no response'}`);
    }

    // cleanip.io loads the purity score asynchronously after DOM ready.
    // Poll briefly until the score renders instead of blocking blindly.
    await page.waitForFunction(
      () => /AI\s*\d{1,3}\s*(?:[A-F][+-]?|S)\s*\/\s*100/i.test(document.body?.innerText ?? ''),
      { timeout: 12000, polling: 400 },
    ).catch(() => {});
    signal?.throwIfAborted();

    // Extract the real purity score from the page DOM.
    const data = await page.evaluate(() => {
      const allText = document.body.innerText ?? '';
      const results = {};

      // Score pattern: "AI{score}{grade}/ 100" e.g. "AI93A+/ 100" or "AI26D/ 100"
      const scoreMatch = allText.match(/AI\s*(\d{1,3})\s*([A-F][+-]?|S)\s*\/\s*100/i);
      if (scoreMatch) {
        results.purityScore = parseInt(scoreMatch[1], 10);
        results.grade = scoreMatch[2].toUpperCase();
      }

      // Proxy detection: "代理与匿名\nX / 6" (or English fallback)
      const proxySection = allText.match(/(?:代理与匿名|Proxy\s*(?:&|and)\s*Anonymity)[\s\S]*?(\d+)\s*\/\s*6/i);
      if (proxySection) results.proxyFlags = parseInt(proxySection[1], 10);

      // Abuse detection: "滥用与自动化\nX / 6" (or English fallback)
      const abuseSection = allText.match(/(?:滥用与自动化|Abuse\s*(?:&|and)\s*Automation)[\s\S]*?(\d+)\s*\/\s*6/i);
      if (abuseSection) results.abuseFlags = parseInt(abuseSection[1], 10);

      // IP from "IPv4 x.x.x.x"
      const ipMatch = allText.match(/IPv4\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      if (ipMatch) results.ip = ipMatch[1];
      else {
        const fallbackIp = allText.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (fallbackIp) results.ip = fallbackIp[1];
      }

      // IP type: avoid matching unrelated "IDC" words in page footers/legends.
      if (/机房\s*IP|数据中心|(?:\bIP\s*类型|\b网络类型)[^\n]*(?:机房|IDC|数据中心|Datacenter)/i.test(allText)) {
        results.ipType = 'datacenter';
      } else if (/住宅|Residential/i.test(allText)) {
        results.ipType = 'residential';
      } else {
        results.ipType = 'unknown';
      }

      // Human/Bot ratio
      const humanMatch = allText.match(/Human\s+([\d.]+)%/);
      const botMatch = allText.match(/Bot\s+([\d.]+)%/);
      if (humanMatch) results.humanPct = humanMatch[1] + '%';
      if (botMatch) results.botPct = botMatch[1] + '%';

      // ASN
      const asnMatch = allText.match(/AS(\d+)/);
      if (asnMatch) results.asn = 'AS' + asnMatch[1];

      const asnOwnerMatch = allText.match(/ASN 归属\s*\n?\s*(.+?)(?:\n|IDC|企业)/);
      if (asnOwnerMatch) results.asnOwner = asnOwnerMatch[1].trim();

      // Location
      const locMatch = allText.match(/归属地\s*\n?\s*(.+?)(?:\n|纠错|ASN)/);
      if (locMatch) results.location = locMatch[1].trim();

      // Overall problems count
      const riskSumMatch = allText.match(/有问题\s*(\d+)/);
      if (riskSumMatch) results.totalProblems = parseInt(riskSumMatch[1], 10);

      return results;
    });

    if (keepOpen) {
      handoff = true;
      return {
        data,
        session: {
          browser,
          context,
          page,
          close: () => closeWithTimeout(browser),
          meta: { engine: 'camoufox', reused: true },
        },
      };
    }

    await page.close().catch(() => {});
    return { data, session: null };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!handoff) await closeWithTimeout(browser);
  }
}

/**
 * Create a temporary proxy-chain bridge for the IP quality check.
 * Returns { browserProxy, server, close }.
 */
async function createBridge(upstream) {
  const { Server } = await import('proxy-chain');
  const bridge = new Server({
    host: '127.0.0.1', port: 0, verbose: false,
    prepareRequestFunction: () => ({ upstreamProxyUrl: upstream }),
  });
  await bridge.listen();
  return {
    browserProxy: { server: `http://127.0.0.1:${bridge.port}` },
    server: bridge.server,
    close: () => bridge.close(true).catch(() => {}),
  };
}

/**
 * Generate a random session ID for proxy rotation.
 */
function randomSessionId() {
  return (`qc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`)
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 13);
}

/**
 * Evaluate whether an IP quality check result passes the threshold.
 *
 * An IP passes when:
 *  - purity score is available and >= threshold
 *  - IP type is NOT datacenter (when requireResidential is set)
 *  - proxy flags < 6 (transparent proxy with zero anonymity is rejected;
 *    residential proxies routinely show 1-2 flags from HTTP headers/timing)
 *  - abuse flags <= maxAbuseFlags (active abuse reputation is rejected)
 */
export function passesThreshold(result, { threshold, requireResidential, maxProxyFlags = 5, maxAbuseFlags = 3 }) {
  if (result.purityScore === undefined) return false;
  if (result.purityScore < threshold) return false;
  if (requireResidential && result.ipType === 'datacenter') return false;
  if ((result.proxyFlags ?? 0) >= 6) return false;
  if ((result.abuseFlags ?? 0) > maxAbuseFlags) return false;
  return true;
}

function resolvePrimaryCountry(config) {
  const fromProgram = config.program?.country;
  if (typeof fromProgram === 'string' && /^[a-z]{2}$/i.test(fromProgram.trim())) {
    return fromProgram.trim().toLowerCase();
  }
  const fromCode = config.data?.countryCode;
  if (typeof fromCode === 'string' && /^[a-z]{2}$/i.test(fromCode.trim())) {
    return fromCode.trim().toLowerCase();
  }
  const fromName = typeof config.data?.country === 'string'
    ? COUNTRY_NAME_TO_CODE[config.data.country.trim().toLowerCase()]
    : undefined;
  return fromName ?? 'us';
}

/**
 * Run the IP quality & availability pre-check loop.
 *
 * Tries the initial proxy first (or generates one when initialProxy is unset).
 * For each candidate, verifies target availability first, then inspects IP
 * purity on cleanip.io. On failure, rebuilds the proxy with a new sticky
 * session ID (same country) on retries 1-3, then switches to fallback countries
 * on retries 4+. Returns the winning proxy or throws.
 */
export async function ensureIpQuality(config, initialProxy, {
  log = () => {},
  signal,
  checkAvailability = checkProxyAvailability,
  checkScore = checkCleanipScore,
} = {}) {
  const iq = config.ipQuality ?? DEFAULTS;
  if (!iq.enabled) {
    log('ip_quality_skipped', { stage: 'ip_quality', reason: 'disabled' });
    return { proxy: initialProxy, skipped: true };
  }

  const provider = resolveDynamicProvider(config);
  if (!provider) {
    log('ip_quality_skipped', { stage: 'ip_quality', reason: 'no_provider' });
    return { proxy: initialProxy, skipped: true };
  }

  signal?.throwIfAborted();

  const primaryCountry = resolvePrimaryCountry(config);
  const headless = config.browser?.headless ?? false;
  const locale = config.browser?.locale ?? 'en-US';
  const keepBrowser = (config.browser?.engine ?? 'camoufox') === 'camoufox' && checkScore === checkCleanipScore;

  // Build the candidate list: primary country first, then distinct fallbacks.
  const candidates = [];
  if (initialProxy?.server) {
    candidates.push({ proxy: initialProxy, country: primaryCountry, sessionId: 'initial', label: 'initial' });
  } else {
    const sid = randomSessionId();
    const dp = provider.build(provider.config, { countryCode: primaryCountry, sessionId: sid });
    candidates.push({ proxy: parseProxy(dp), country: primaryCountry, sessionId: sid, label: 'initial' });
  }

  // Retries 1-3: same country, new session IDs.
  for (let i = 1; i <= Math.min(3, iq.maxRetries); i++) {
    const sid = randomSessionId();
    const dp = provider.build(provider.config, { countryCode: primaryCountry, sessionId: sid });
    candidates.push({ proxy: parseProxy(dp), country: primaryCountry, sessionId: sid, label: `retry-${i}-${primaryCountry}` });
  }

  // Retries 4+: fallback countries (excluding primaryCountry when alternatives exist).
  const distinctFallbacks = iq.fallbackCountries.filter(c => c !== primaryCountry);
  const fallbacks = distinctFallbacks.length > 0 ? distinctFallbacks : iq.fallbackCountries;
  if (fallbacks.length > 0) {
    for (let i = 4; i <= iq.maxRetries; i++) {
      const fcIndex = (i - 4) % fallbacks.length;
      const fc = fallbacks[fcIndex];
      const sid = randomSessionId();
      const dp = provider.build(provider.config, { countryCode: fc, sessionId: sid });
      candidates.push({ proxy: parseProxy(dp), country: fc, sessionId: sid, label: `retry-${i}-${fc}` });
    }
  }

  const attempts = [];

  for (const candidate of candidates) {
    signal?.throwIfAborted();

    log('ip_quality_attempt', { stage: 'ip_quality', provider: provider.name, label: candidate.label, country: candidate.country, sessionId: candidate.sessionId });

    const upstream = upstreamProxyUrl(candidate.proxy);
    let bridge;
    let screenedSession;
    try {
      bridge = await createBridge(upstream);
      await checkAvailability(bridge.browserProxy, { timeoutMs: 10000, signal });
      const scoreOutput = await checkScore(bridge.browserProxy, {
        headless, locale, timeoutMs: 30000, signal, keepOpen: keepBrowser,
      });
      const result = scoreOutput?.data ?? scoreOutput;
      screenedSession = scoreOutput?.session ?? null;

      const passed = passesThreshold(result, iq);
      const summary = {
        label: candidate.label,
        country: candidate.country,
        sessionId: candidate.sessionId,
        ip: result.ip,
        score: result.purityScore,
        grade: result.grade,
        proxyFlags: result.proxyFlags,
        abuseFlags: result.abuseFlags,
        ipType: result.ipType,
        humanPct: result.humanPct,
        botPct: result.botPct,
        asn: result.asn,
        asnOwner: result.asnOwner,
        location: result.location,
        passed,
      };
      attempts.push(summary);
      log('ip_quality_result', { stage: 'ip_quality', ...summary });

      if (passed) {
        log('ip_quality_passed', { stage: 'ip_quality', provider: provider.name, ip: result.ip, score: result.purityScore, grade: result.grade, country: candidate.country });
        const reuseBridge = keepBrowser && Boolean(screenedSession);
        if (!reuseBridge) {
          await screenedSession?.close();
          await bridge.close();
          bridge = null;
          screenedSession = null;
        }
        return {
          provider: provider.name,
          proxy: candidate.proxy,
          score: result.purityScore,
          grade: result.grade,
          ip: result.ip,
          country: candidate.country,
          sessionId: candidate.sessionId,
          ipType: result.ipType,
          asn: result.asn,
          asnOwner: result.asnOwner,
          location: result.location,
          attempts,
          ...(reuseBridge ? { bridge, session: screenedSession } : {}),
        };
      }
      await screenedSession?.close();
      await bridge.close();
      bridge = null;
    } catch (error) {
      await screenedSession?.close().catch(() => {});
      await bridge?.close();
      if (signal?.aborted) throw error;
      attempts.push({ label: candidate.label, country: candidate.country, sessionId: candidate.sessionId, error: error.message, passed: false });
      log('ip_quality_error', { stage: 'ip_quality', label: candidate.label, error: error.message });
      // Continue to next candidate.
    }
  }

  // All attempts failed.
  const best = attempts.filter(a => a.score !== undefined).sort((a, b) => b.score - a.score)[0];
  const detail = attempts.map(a => `${a.label}: ${a.score ?? 'error'} ${a.grade ?? ''} (${a.ipType ?? a.error ?? '?'})`).join('; ');
  throw new AutomationError('PROXY_QUALITY_FAILED',
    `IP 质量检查未通过：经过 ${attempts.length} 次尝试，没有获得分数 ≥ ${iq.threshold} 的${iq.requireResidential ? '住宅' : ''} IP。` +
    `最高分: ${best?.score ?? 'N/A'} (${best?.grade ?? '?'})。详情: ${detail}`);
}
