import { AsyncLocalStorage } from 'node:async_hooks';
import { AutomationError } from './errors.js';
import { parseProxy, upstreamProxyUrl } from './proxy.js';

const networks = new AsyncLocalStorage();

// Runtime scope, not a global dispatcher: nested executors reuse one route,
// while independent library calls can use different proxies safely.
export async function withNetwork(config, operation, { existingBridge } = {}) {
  const existing = networks.getStore();
  if (existing && existing.configuredProxy === config.proxy) return operation();
  const proxy = parseProxy(config.proxy);
  const runtime = { configuredProxy: config.proxy, browserProxy: undefined, dispatcher: undefined, failed: false };
  if (!proxy) {
    await existingBridge?.close?.();
    return networks.run(runtime, operation);
  }
  let bridge;
  try {
    const [{ Server }, { ProxyAgent }] = await Promise.all([import('proxy-chain'), import('undici')]);
    if (existingBridge) {
      bridge = existingBridge;
    } else {
      const upstream = upstreamProxyUrl(proxy);
      const server = new Server({
        host: '127.0.0.1', port: 0, verbose: false,
        prepareRequestFunction: () => ({ upstreamProxyUrl: upstream }),
      });
      await server.listen();
      bridge = {
        browserProxy: { server: `http://127.0.0.1:${server.port}` },
        server: server.server,
        close: () => server.close(true).catch(() => {}),
      };
    }
    bridge.server?.on?.('error', () => { runtime.failed = true; });
    const serverUrl = bridge.browserProxy.server;
    runtime.browserProxy = { server: serverUrl };
    runtime.dispatcher = new ProxyAgent({ uri: serverUrl });
  } catch {
    await runtime.dispatcher?.destroy().catch(() => {});
    await bridge?.close?.();
    throw new AutomationError('PROXY_START_FAILED', '无法启动本机代理转接，请检查依赖和本机端口权限；未改用直连');
  }
  try {
    return await networks.run(runtime, operation);
  } finally {
    try { await runtime.dispatcher.destroy(); } finally { await bridge.close(); }
  }
}

export function browserProxy() {
  return networks.getStore()?.browserProxy;
}

export function networkFetch(url, options = {}) {
  const runtime = networks.getStore();
  if (runtime?.failed) throw new AutomationError('PROXY_UNAVAILABLE', '代理转接不可用，已停止请求；未改用直连');
  return fetch(url, { ...options, ...(runtime?.dispatcher ? { dispatcher: runtime.dispatcher } : {}) });
}
