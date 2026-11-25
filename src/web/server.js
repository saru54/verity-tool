import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AutomationError, requireValue } from '../core/errors.js';
import { WebJobs, DEDUPLICATED } from './jobs.js';
import { isMainModule } from '../../scripts/process.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/login', ['login.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/login.js', ['login.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

// Static shell is public: the login form itself needs app.js/style.css to render.
const PUBLIC_ASSETS = new Set(assets.keys());

const SESSION_COOKIE = 'one-session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // one week of idle time
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// Brute-force throttle per source address: doubling delay up to 2s, entries
// age out after 15 minutes. In-memory by design — a restart releases everything.
const LOGIN_THROTTLE_BASE_MS = 100;
const LOGIN_THROTTLE_MAX_MS = 2000;
const LOGIN_THROTTLE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Normalize one account into {username, digest} where digest is the sha256 of
 * the password. A value shaped `sha256:<64 hex>` is accepted pre-hashed so
 * deployments never need to store the plaintext in a file or env var.
 */
function normalizeAccount(username, password) {
  requireValue(typeof username === 'string' && USERNAME_PATTERN.test(username.trim()),
    `账号名必须为 1-64 位字母数字或 ._-：${JSON.stringify(username).slice(0, 70)}`);
  requireValue(typeof password === 'string' && password.length >= 4, `账号 ${username.trim()} 的密码至少需要 4 位`);
  const user = username.trim();
  const value = password.trim();
  const hashed = /^sha256:[a-f\d]{64}$/i.test(value);
  return { username: user, digest: hashed ? Buffer.from(value.slice(7), 'hex') : createHash('sha256').update(value).digest() };
}

/**
 * Parse the credential sources into a Map<username, Buffer digest>.
 * Priority: explicit option array > ONE_WEB_USERS pairs > ONE_WEB_USERNAME/ONE_WEB_PASSWORD
 * (ONE_WEB_PASSWORD alone keeps the historical "admin" account working).
 */
export function parseAccounts({ users, username, password, env = process.env } = {}) {
  const accounts = new Map();
  const add = raw => {
    const account = normalizeAccount(raw.username, raw.password);
    if (accounts.has(account.username)) throw new AutomationError('INVALID_CONFIG', `账号 ${account.username} 重复配置`);
    accounts.set(account.username, account.digest);
    return account;
  };
  if (Array.isArray(users) && users.length > 0) {
    users.forEach(add);
  } else {
    const pairs = String(env.ONE_WEB_USERS ?? '').trim();
    if (pairs) {
      for (const pair of pairs.split(',').map(item => item.trim()).filter(Boolean)) {
        const separator = pair.indexOf(':');
        requireValue(separator > 0, 'ONE_WEB_USERS 每项必须为 账号:密码 形式，逗号分隔');
        add({ username: pair.slice(0, separator), password: pair.slice(separator + 1) });
      }
    } else if (typeof password === 'string' && password.trim()) {
      add({ username: username ?? env.ONE_WEB_USERNAME ?? 'admin', password });
    } else if (typeof username === 'string' && username.trim()) {
      normalizeAccount(username, '');
    }
  }
  return accounts;
}

export function createWebServer({ port = 8787, host = '0.0.0.0', publicOrigin,
  users, username, password = process.env.ONE_WEB_PASSWORD ?? '',
  configFile = resolve('config/sheerid.local.json'), workflow } = {}) {
  requireValue(['127.0.0.1', '0.0.0.0'].includes(host), 'Web 监听地址无效');
  let published;
  if (publicOrigin) {
    try { published = new URL(publicOrigin); } catch { throw new AutomationError('INVALID_CONFIG', '公网地址无效'); }
    requireValue(published.protocol === 'https:' && !published.username && !published.password
      && published.pathname === '/' && !published.search && !published.hash, '公网地址必须为 HTTPS 域名');
  }
  // Accounts are the front gate for a network-exposed workspace: without one
  // nothing could ever log in, so refuse to start instead of serving openly.
  const accounts = parseAccounts({ users, username, password });
  requireValue(accounts.size > 0, '必须配置登录账号：请设置 ONE_WEB_PASSWORD（账号 admin），或 ONE_WEB_USERS=账号:密码（多个用逗号分隔）');
  const server = createServer((request, response) => {
    handle(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const status = ['JOB_NOT_FOUND', 'MATERIAL_NOT_FOUND', 'MATERIAL_FILE_NOT_FOUND'].includes(error.code) ? 404
        : ['SERVER_STOPPING', 'JOB_ACTIVE'].includes(error.code) ? 409
          : error.code === 'FORBIDDEN' ? 403 : error.code === 'BODY_TOO_LARGE' ? 413
            : error instanceof AutomationError ? 400 : 500;
      json(response, status, { error: { code: error instanceof AutomationError ? error.code : 'WEB_ERROR',
        message: error instanceof AutomationError ? error.message : '请求处理失败，请重试' } });
    });
  });
  server.requestTimeout = 120000;

  const jobs = new WebJobs({ configFile, workflow });
  // One session per successful login; the write token lives in the session so
  // a stolen cookie alone cannot pass the CSRF check without reading /api/session.
  const sessions = new Map(); // sessionId -> { username, token, expiresAt }
  const throttles = new Map(); // ip -> { count, firstAt, blockedUntil }
  let origin;
  let closed = false;

  function sweepSessions(now = Date.now()) {
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    for (const [ip, entry] of throttles) if (entry.firstAt + LOGIN_THROTTLE_WINDOW_MS <= now) throttles.delete(ip);
  }

  function clientAddress(request) {
    return request.socket?.remoteAddress ?? 'unknown';
  }

  function readSession(request) {
    const cookie = (request.headers.cookie ?? '').split(';').map(item => item.trim())
      .find(item => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) ?? '';
    if (!/^[a-f\d]{64}$/i.test(cookie)) return null;
    const session = sessions.get(cookie.toLowerCase());
    if (!session || session.expiresAt <= Date.now()) return null;
    return { id: cookie.toLowerCase(), ...session };
  }

  function allowHost(request) {
    const address = server.address();
    const hosts = [`127.0.0.1:${address?.port}`, `localhost:${address?.port}`];
    if (published) {
      hosts.push(published.host);
      if (!hosts.includes(request.headers.host)) throw new AutomationError('FORBIDDEN', '仅允许通过配置的域名访问');
    }
    // Origin check always runs — CSRF protection is needed regardless of whether
    // a public origin is configured. When published, the expected origin is the
    // configured HTTPS URL; otherwise it is the http:// + Host the browser used.
    const expectedOrigin = published && request.headers.host === published.host ? published.origin : `http://${request.headers.host}`;
    if (request.headers.origin && request.headers.origin !== expectedOrigin
      && !(published && request.headers.origin === published.origin)) {
      throw new AutomationError('FORBIDDEN', '请求来源不匹配');
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new AutomationError('FORBIDDEN', '请求来源不匹配');
  }

  function setSessionCookie(response, id, { clear = false } = {}) {
    response.setHeader('Set-Cookie',
      `${SESSION_COOKIE}=${clear ? '' : id}; Path=/; HttpOnly; SameSite=Strict${published ? '; Secure' : ''}`
      + (clear ? '; Max-Age=0' : `; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`));
  }

  async function handle(request, response) {
    if (closed) { json(response, 503, { error: { code: 'SERVER_STOPPING', message: '服务正在关闭' } }); return; }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url = new URL(request.url, origin);
    const session = readSession(request);
    if (request.method === 'GET' && PUBLIC_ASSETS.has(url.pathname)) {
      allowHost(request);
      const [filename, type] = assets.get(url.pathname);
      response.writeHead(200, { 'Content-Type': type });
      response.end(await readFile(new URL(`./public/${filename}`, import.meta.url)));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/login') {
      await login(request, response);
      return;
    }
    // Host/Origin checks run before the session gate so a cross-site probe is
    // told "wrong origin" (403) rather than "not logged in" (401).
    allowHost(request);
    if (!session) {
      json(response, 401, { error: { code: 'UNAUTHORIZED', message: '请先登录' } });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      sessions.delete(session.id);
      setSessionCookie(response, '', { clear: true });
      json(response, 200, { loggedOut: true });
      return;
    }
    if (request.method !== 'GET' && request.headers['x-local-token'] !== session.token) {
      throw new AutomationError('FORBIDDEN', '页面会话已失效，请刷新后重试');
    }
    if (request.method === 'GET' && url.pathname === '/api/session') {
      json(response, 200, { username: session.username, token: session.token });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/settings/proxy') {
      json(response, 200, await jobs.readProxySettings());
      return;
    }
    if (request.method === 'PUT' && url.pathname === '/api/settings/proxy') {
      requireValue(request.headers['content-type']?.split(';')[0] === 'application/json', '请求需要 JSON 格式');
      let body;
      try { body = JSON.parse((await readBody(request, 16 * 1024)).toString('utf8')); }
      catch { throw new AutomationError('INVALID_CONFIG', '请求内容不是有效 JSON'); }
      json(response, 200, await jobs.saveProxySettings(body));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/settings/dataimpulse') {
      json(response, 200, await jobs.readDataImpulse());
      return;
    }
    if (request.method === 'PUT' && url.pathname === '/api/settings/dataimpulse') {
      requireValue(request.headers['content-type']?.split(';')[0] === 'application/json', '请求需要 JSON 格式');
      let body;
      try { body = JSON.parse((await readBody(request, 16 * 1024)).toString('utf8')); }
      catch { throw new AutomationError('INVALID_CONFIG', '请求内容不是有效 JSON'); }
      json(response, 200, await jobs.saveDataImpulse(body?.dataimpulse ?? null));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/jobs') {
      json(response, 200, jobs.list());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/materials') {
      json(response, 200, await jobs.listMaterials());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/universities') {
      const { loadUniversities } = await import('../materials/index.js');
      const countryParam = url.searchParams.get('country');
      const countryKey = typeof countryParam === 'string' && ['us', 'ca', 'gb', 'de'].includes(countryParam.toLowerCase())
        ? countryParam.toLowerCase() : 'us';
      const universities = await loadUniversities(countryKey);
      json(response, 200, { universities: universities.map(entry => ({
        id: entry.id, name: entry.name, shortName: entry.shortName, city: entry.city,
        state: entry.state, emailDomain: entry.emailDomain,
      })) });
      return;
    }
    const materialRoute = url.pathname.match(/^\/api\/materials\/([a-f\d]{24})(?:\/files\/([A-Za-z0-9._-]{1,80}))?$/i);
    if (materialRoute && request.method === 'GET') {
      if (!materialRoute[2]) {
        json(response, 200, { material: await jobs.getMaterial(materialRoute[1]) });
        return;
      }
      const { entry, bytes } = await jobs.getMaterialFile(materialRoute[1], materialRoute[2]);
      response.writeHead(200, {
        'Content-Type': entry.mimeType,
        'Content-Length': bytes.length,
        'Content-Disposition': `inline; filename="${entry.name}"`,
        'Cache-Control': 'no-store',
      });
      response.end(bytes);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/jobs') {
      requireValue(request.headers['content-type']?.split(';')[0] === 'application/json', '任务请求需要 JSON 格式');
      let input;
      try { input = JSON.parse((await readBody(request, 64 * 1024)).toString('utf8')); }
      catch (error) {
        if (error instanceof AutomationError) throw error;
        throw new AutomationError('INVALID_CONFIG', '表单内容不是有效 JSON');
      }
      const job = await jobs.start(input);
      json(response, 202, { job, ...(job[DEDUPLICATED] ? { deduplicated: true } : {}) });
      return;
    }
    const jobRoute = url.pathname.match(/^\/api\/jobs\/([a-f\d]{24})(\/(?:cancel|resume|events))?$/i);
    if (jobRoute && request.method === 'DELETE' && !jobRoute[2]) {
      json(response, 200, jobs.remove(jobRoute[1]));
      return;
    }
    if (jobRoute?.[2]?.toLowerCase() === '/events' && request.method === 'GET') {
      const body = await jobs.getEvents(jobRoute[1]);
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${jobRoute[1]}.events.json"`,
        'Cache-Control': 'no-store',
      });
      response.end(body);
      return;
    }
    if (jobRoute && request.method === 'GET' && !jobRoute[2]) {
      const after = Number(url.searchParams.get('after') ?? 0);
      requireValue(Number.isSafeInteger(after) && after >= 0, '日志位置无效');
      json(response, 200, jobs.get(jobRoute[1], after));
      return;
    }
    if (jobRoute?.[2] && request.method === 'POST') {
      json(response, 200, { job: jobRoute[2].toLowerCase() === '/resume'
        ? jobs.resume(jobRoute[1]) : jobs.cancel(jobRoute[1]) });
      return;
    }
    json(response, 404, { error: { code: 'NOT_FOUND', message: '页面或接口不存在' } });
  }

  function throttleEntry(ip) {
    const now = Date.now();
    const entry = throttles.get(ip);
    if (!entry || entry.firstAt + LOGIN_THROTTLE_WINDOW_MS <= now) {
      const fresh = { count: 0, firstAt: now, blockedUntil: 0 };
      throttles.set(ip, fresh);
      return fresh;
    }
    return entry;
  }

  async function login(request, response) {
    allowHost(request);
    const ip = clientAddress(request);
    const throttle = throttleEntry(ip);
    // Reject while the throttle window is open, regardless of the credentials:
    // a blocking gate, not a slowdown, so probes cannot keep verifying guesses.
    if (Date.now() < throttle.blockedUntil) {
      json(response, 429, { error: { code: 'TOO_MANY_ATTEMPTS', message: '尝试过于频繁，请稍后再试' } });
      return;
    }
    let body;
    try { body = JSON.parse((await readBody(request, 4 * 1024)).toString('utf8') || '{}'); }
    catch { body = null; }
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const passwordAttempt = typeof body?.password === 'string' ? body.password : '';
    const digest = createHash('sha256').update(passwordAttempt).digest();
    const expectedDigest = accounts.get(username);
    const userOk = expectedDigest !== undefined;
    // Compare both fields in constant time regardless of which one is wrong,
    // so a probe cannot distinguish wrong-username from wrong-password.
    const match = timingSafeEqual(digest, userOk ? expectedDigest : Buffer.alloc(32));
    if (!body || !userOk || !match) {
      throttle.count += 1;
      // A single typo stays unblocked; from the second failure onward the
      // source address waits out a doubling backoff (capped at 2s).
      if (throttle.count >= 2) {
        throttle.blockedUntil = Date.now()
          + Math.min(LOGIN_THROTTLE_BASE_MS * 2 ** (throttle.count - 1), LOGIN_THROTTLE_MAX_MS);
      }
      json(response, 401, { error: { code: 'INVALID_CREDENTIALS', message: '账号或密码不正确' } });
      return;
    }
    throttles.delete(ip);
    sweepSessions();
    const id = randomBytes(32).toString('hex');
    const token = randomBytes(32).toString('hex');
    sessions.set(id, { username, token, expiresAt: Date.now() + SESSION_TTL_MS });
    setSessionCookie(response, id);
    json(response, 200, { username, token });
  }

  return {
    server, jobs,
    get sessionCount() { return sessions.size; },
    async start() {
      await jobs.initialize();
      await new Promise((resolveStarted, reject) => {
        const fail = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); resolveStarted(); };
        server.once('error', fail);
        server.once('listening', ready);
        server.listen(port, host);
      });
      const address = server.address();
      origin = `http://127.0.0.1:${address.port}`;
      const exposed = address.address === '::' ? '0.0.0.0' : address.address;
      return published?.origin ?? `http://${excludedLoopback(exposed)}:${address.port}`;
    },
    async close() {
      closed = true;
      await jobs.close();
      server.closeAllConnections();
      if (server.listening) await new Promise(resolveClosed => server.close(resolveClosed));
    },
  };
}

function excludedLoopback(address) {
  return address === '0.0.0.0' || address === '::' ? '127.0.0.1' : address;
}

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) throw new AutomationError('BODY_TOO_LARGE', '文件或请求内容超过大小限制');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new AutomationError('BODY_TOO_LARGE', '文件或请求内容超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8787' } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须为 1024–65535 的整数');
  const app = createWebServer({ port, host: process.env.ONE_WEB_HOST || '0.0.0.0',
    publicOrigin: process.env.ONE_WEB_PUBLIC_ORIGIN,
    username: process.env.ONE_WEB_USERNAME,
    password: process.env.ONE_WEB_PASSWORD });
  const shutdown = () => { void app.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  app.start().then(origin => {
    const created = app.jobs.configCreated
      ? `首次启动已根据 config/sheerid.example.json 生成 config/sheerid.local.json\n`
      : '';
    process.stdout.write(`${created}sheeridVerify 工作台已启动：${origin}\n通过浏览器登录后使用；按 Ctrl+C 关闭服务。\n`);
  }).catch(error => {
    process.stderr.write(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请用 --port 指定其他端口。\n`
      : error instanceof AutomationError ? `Web 服务启动失败：${error.message}\n` : 'Web 服务启动失败。\n');
    process.exitCode = 1;
    void app.close();
  });
}
