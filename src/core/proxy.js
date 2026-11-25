import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AutomationError, requireValue } from './errors.js';

const DIRECT = new Set(['direct', 'none', 'off']);

// Unset, null, blank strings and objects whose fields are all blank mean "not configured".
function isUnset(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.values(value).every(item => item === undefined || item === null
      || (typeof item === 'string' && item.trim() === ''));
  }
  return false;
}

function isDirect(value) {
  return value === false || (typeof value === 'string' && DIRECT.has(value.trim().toLowerCase()));
}

/**
 * Resolve the effective proxy for a run:
 * - false / "direct": connect directly;
 * - an explicit proxy: use it;
 * - unset (missing, null, "" or all-blank object): use the current system proxy, else direct.
 */
export async function resolveProxy(value, env = process.env) {
  if (isDirect(value)) return null;
  if (!isUnset(value)) return parseProxy(value);
  return systemProxy(env);
}

export async function systemProxy(env = process.env) {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) return parseSystemProxy(value, `环境变量 ${name}`);
  }
  if (process.platform !== 'win32') return null;
  const settings = await readWindowsInternetSettings();
  if (!settings || Number(settings.ProxyEnable) !== 1 || !settings.ProxyServer?.trim()) return null;
  return parseSystemProxy(pickWindowsProxy(settings.ProxyServer), 'Windows 系统代理');
}

async function readWindowsInternetSettings() {
  try {
    const { stdout } = await promisify(execFile)('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { windowsHide: true, timeout: 5000 });
    const values = {};
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);
      if (match) values[match[1]] = match[2].trim();
    }
    // REG_DWORD values are printed as hex, e.g. 0x1.
    if (values.ProxyEnable) values.ProxyEnable = Number.parseInt(values.ProxyEnable, 16);
    return values;
  } catch {
    return null; // Registry unavailable: behave as if no system proxy is configured.
  }
}

// ProxyServer is either "host:port" or "http=host:port;https=host:port;socks=host:port".
function pickWindowsProxy(value) {
  if (!value.includes('=')) return value;
  const entries = Object.fromEntries(value.split(';').map(part => part.trim().split('=', 2))
    .filter(([key, server]) => key && server).map(([key, server]) => [key.toLowerCase(), server.trim()]));
  if (entries.https) return entries.https;
  if (entries.http) return entries.http;
  if (entries.socks) return /^[a-z][a-z\d+.-]*:\/\//i.test(entries.socks) ? entries.socks : `socks5://${entries.socks}`;
  return '';
}

function parseSystemProxy(value, source) {
  try {
    return parseProxy(value);
  } catch {
    throw new AutomationError('INVALID_SYSTEM_PROXY', `${source} 的代理地址无效；请修正系统代理，或在配置中显式设置 proxy（"direct" 表示直连）`);
  }
}

export function parseProxy(value) {
  if (isUnset(value) || isDirect(value)) return null;
  try {
    const object = typeof value === 'object' && !Array.isArray(value);
    if (object) {
      requireValue(Object.keys(value).every(key => ['server', 'username', 'password'].includes(key)), 'proxy 包含不支持的配置项');
      for (const key of ['username', 'password']) {
        requireValue(value[key] === undefined || typeof value[key] === 'string', '代理账号密码必须是字符串');
      }
    }
    let input = object ? value.server : value;
    requireValue(typeof input === 'string' && input.trim().length > 0, '代理地址必须是非空字符串');
    input = input.trim().replace(/^sock5:\/\//i, 'socks5://');
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) input = `http://${input}`;
    // Also accept the provider's host:port:username:password notation, keeping
    // colons in the password. Standard URLs must percent-encode credentials.
    const short = input.match(/^(https?|socks5h?):\/\/(\[[^\]]+\]|[^:/\s]+):(\d+):([^:]*):(.*)$/i);
    if (short && !input.slice(input.indexOf('://') + 3).includes('@')) {
      input = `${short[1]}://${encodeURIComponent(short[4])}:${encodeURIComponent(short[5])}@${short[2]}:${short[3]}`;
    }
    const url = new URL(input);
    requireValue(['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol), '代理仅支持 HTTP、HTTPS 或 SOCKS5');
    requireValue(Boolean(url.hostname) && !url.search && !url.hash && ['', '/'].includes(url.pathname), '代理地址不能包含路径或查询参数');
    const embedded = Boolean(url.username || url.password);
    requireValue(!(embedded && object && (value.username !== undefined || value.password !== undefined)), '代理凭据只能写在 URL 或独立字段中的一处');
    const username = embedded ? decodeURIComponent(url.username) : object ? value.username ?? '' : '';
    const password = embedded ? decodeURIComponent(url.password) : object ? value.password ?? '' : '';
    requireValue(!/[\r\n\0]/.test(username + password) && (!password || username.length > 0), '代理凭据格式无效');
    if (url.protocol.startsWith('socks5') && !url.port) url.port = '1080';
    requireValue(url.port !== '0', '代理端口必须大于 0');
    return Object.freeze({ server: `${url.protocol}//${url.host}`, username, password });
  } catch {
    // URL/parser exceptions can contain the entire password-bearing input.
    throw new AutomationError('INVALID_PROXY', '代理配置无效；请使用 HTTP/SOCKS5 地址，或 host:port:username:password 格式');
  }
}

export function upstreamProxyUrl(proxy) {
  const url = new URL(proxy.server);
  // Resolve target hostnames at the SOCKS5 upstream for both HTTP and CONNECT.
  if (url.protocol === 'socks5:') url.protocol = 'socks5h:';
  url.username = encodeURIComponent(proxy.username);
  url.password = encodeURIComponent(proxy.password);
  return url.href;
}

/**
 * DataImpulse dynamic proxy builder.
 *
 * Builds a proxy string with country targeting and a sticky session ID so the
 * proxy region matches the university country and the IP stays stable for the
 * duration of a verification task (30 minutes per DataImpulse spec).
 *
 * Reference: https://docs.dataimpulse.com/proxies/parameters/country.md
 *            https://docs.dataimpulse.com/proxies/parameters/session-id.md
 *
 * @param {object} dataimpulse - { host, port, username, password }
 * @param {object} options - { countryCode, sessionId }
 * @returns {object} frozen proxy object { server, username, password }
 */
export function buildDataImpulseProxy(dataimpulse, { countryCode = 'us', sessionId } = {}) {
  requireValue(isRecord(dataimpulse), 'dataimpulse 配置必须是一个对象');
  const host = dataimpulse.host ?? 'gw.dataimpulse.com';
  // DataImpulse sticky proxy ports: 10000–20000 (IP bound to port, ~30min hold).
  // Rotating ports are 823 (HTTP) / 824 (SOCKS5) but do not support sessid.
  // We default to 10000 so the sticky session ID keeps the same IP per task.
  const port = dataimpulse.port ?? 10000;
  const username = dataimpulse.username;
  const password = dataimpulse.password;
  requireValue(typeof host === 'string' && host.trim().length > 0, 'dataimpulse.host 必须是非空字符串');
  requireValue(typeof username === 'string' && username.trim().length > 0, 'dataimpulse.username 必须是非空字符串');
  requireValue(typeof password === 'string' && password.length > 0, 'dataimpulse.password 不能为空');

  // Build the DataImpulse targeting string:
  // login__cr.us;sessid.task1234567890abcdef
  let targeting = `__cr.${countryCode.toLowerCase()}`;
  if (sessionId) targeting += `;sessid.${sessionId}`;

  const fullUsername = `${username}${targeting}`;
  const server = `http://${host}:${port}`;
  return Object.freeze({ server, username: fullUsername, password });
}

// Normalize a dataimpulse config section (used by config.js).
export function normalizeDataImpulseConfig(value) {
  if (isUnset(value)) return null;
  requireValue(isRecord(value), 'dataimpulse 必须是一个对象');
  // Accept legacy useStateTargeting key in existing local configs without failing,
  // though proxy construction now targets country only.
  requireValue(Object.keys(value).every(key => ['host', 'port', 'username', 'password', 'useStateTargeting'].includes(key)),
    'dataimpulse 包含不支持的配置项');
  const host = typeof value.host === 'string' ? value.host.trim() : 'gw.dataimpulse.com';
  // Default sticky port 10000 (range 10000–20000 per DataImpulse sticky spec).
  const port = typeof value.port === 'number' ? value.port : 10000;
  requireValue(Number.isInteger(port) && port > 0 && port <= 65535, 'dataimpulse.port 必须是 1–65535 的整数（sticky 端口 10000–20000）');
  requireValue(typeof value.username === 'string' && value.username.trim().length > 0, 'dataimpulse.username 必须是非空字符串');
  requireValue(typeof value.password === 'string' && value.password.length > 0, 'dataimpulse.password 不能为空');
  return Object.freeze({
    host: host || 'gw.dataimpulse.com',
    port,
    username: value.username.trim(),
    password: value.password,
  });
}

export const PROXY_PROVIDERS = Object.freeze(['nodemaven', 'dataimpulse']);
export const DEFAULT_PROXY_PROVIDER = 'nodemaven';
const NODEMAVEN_FILTERS = Object.freeze({
  medium: '-filter-medium',
  'medium-fast': '-filter-medium-speed-fast',
  'speed-fast': '-speed-fast',
  none: '',
});

/**
 * NodeMaven dynamic residential/mobile proxy builder.
 *
 * Follows NodeMaven's documented username parameter order:
 * USERNAME-country-{cc}-ipv4-true-sid-{sid}-{filter}
 *
 * Reference: https://docs.nodemaven.com/
 *   - Gateway host: gate.nodemaven.com
 *   - HTTP ports: 8080-9080, 32000-33000 (default 8080)
 *   - SOCKS5 ports: 1080-2080, 42000-43000 (default 1080)
 */
export function buildNodeMavenProxy(nodemaven, { countryCode = 'us', sessionId } = {}) {
  requireValue(isRecord(nodemaven), 'nodemaven 配置必须是一个对象');
  const host = nodemaven.host ?? 'gate.nodemaven.com';
  const port = nodemaven.port ?? 8080;
  const username = nodemaven.username;
  const password = nodemaven.password;
  requireValue(typeof host === 'string' && host.trim().length > 0, 'nodemaven.host 必须是非空字符串');
  requireValue(typeof username === 'string' && username.trim().length > 0, 'nodemaven.username 必须是非空字符串');
  requireValue(typeof password === 'string' && password.length > 0, 'nodemaven.password 不能为空');

  const cc = String(countryCode || 'us').trim().toLowerCase();
  const ipv4Only = nodemaven.ipv4Only !== false;
  const filterKey = nodemaven.filter ?? 'medium';
  requireValue(Object.hasOwn(NODEMAVEN_FILTERS, filterKey), 'nodemaven.filter 仅支持 medium、medium-fast、speed-fast 或 none');

  // NodeMaven separates parameters with '-', so strip hyphens from session IDs.
  const cleanSid = sessionId ? String(sessionId).replace(/[^a-z0-9]/gi, '') : '';
  const parts = [`${username.trim()}-country-${cc}`];
  if (ipv4Only) parts.push('-ipv4-true');
  if (cleanSid) parts.push(`-sid-${cleanSid}`);
  const filterSuffix = NODEMAVEN_FILTERS[filterKey];
  if (filterSuffix) parts.push(filterSuffix);

  const socks5 = (port >= 1080 && port <= 2080) || (port >= 42000 && port <= 43000);
  const scheme = socks5 ? 'socks5' : 'http';
  return Object.freeze({
    server: `${scheme}://${host.trim()}:${port}`,
    username: parts.join(''),
    password,
  });
}

export function normalizeNodeMavenConfig(value) {
  if (isUnset(value)) return null;
  requireValue(isRecord(value), 'nodemaven 必须是一个对象');
  requireValue(Object.keys(value).every(key => ['host', 'port', 'username', 'password', 'filter', 'ipv4Only'].includes(key)),
    'nodemaven 包含不支持的配置项');
  const host = typeof value.host === 'string' && value.host.trim() ? value.host.trim() : 'gate.nodemaven.com';
  const port = typeof value.port === 'number' ? value.port : 8080;
  requireValue(Number.isInteger(port) && port > 0 && port <= 65535, 'nodemaven.port 必须是 1–65535 的整数（HTTP 常用 8080）');
  requireValue(typeof value.username === 'string' && value.username.trim().length > 0, 'nodemaven.username 必须是非空字符串');
  requireValue(typeof value.password === 'string' && value.password.length > 0, 'nodemaven.password 不能为空');
  const filter = value.filter === undefined ? 'medium' : String(value.filter).trim().toLowerCase();
  requireValue(Object.hasOwn(NODEMAVEN_FILTERS, filter), 'nodemaven.filter 仅支持 medium、medium-fast、speed-fast 或 none');
  const ipv4Only = value.ipv4Only === undefined ? true : value.ipv4Only;
  requireValue(typeof ipv4Only === 'boolean', 'nodemaven.ipv4Only 必须是布尔值');
  return Object.freeze({
    host,
    port,
    username: value.username.trim(),
    password: value.password,
    filter,
    ipv4Only,
  });
}

/**
 * Resolve which dynamic proxy provider should be used for a config.
 * Explicit proxyProvider ("nodemaven" | "dataimpulse" | "direct") wins;
 * otherwise NodeMaven is preferred when configured, falling back to DataImpulse.
 */
export function resolveDynamicProvider(config) {
  if (!config) return null;
  const selected = config.proxyProvider;
  if (selected === 'direct') return null;
  if (selected === 'nodemaven') {
    return config.nodemaven ? { name: 'nodemaven', config: config.nodemaven, build: buildNodeMavenProxy } : null;
  }
  if (selected === 'dataimpulse') {
    return config.dataimpulse ? { name: 'dataimpulse', config: config.dataimpulse, build: buildDataImpulseProxy } : null;
  }
  if (config.nodemaven) return { name: 'nodemaven', config: config.nodemaven, build: buildNodeMavenProxy };
  if (config.dataimpulse) return { name: 'dataimpulse', config: config.dataimpulse, build: buildDataImpulseProxy };
  return null;
}

export function buildDynamicProxy(config, options) {
  const provider = resolveDynamicProvider(config);
  if (!provider) return null;
  return provider.build(provider.config, options);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
