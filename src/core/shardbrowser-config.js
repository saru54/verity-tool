import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutomationError, requireValue } from './errors.js';

// Default credential file at the repository root. It is gitignored because it
// holds the launcher API key; shardbrowser.example.json is the committed template.
export const DEFAULT_SHARDBROWSER_FILE = fileURLToPath(new URL('../../shardbrowser.json', import.meta.url));
const ALLOWED_KEYS = ['endpoint', 'token', 'platform', 'timeoutMs', 'language'];
const DEFAULT_ENDPOINT = 'http://127.0.0.1:40325';

function isUnset(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function assertAllowedKeys(value, allowed, label) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} 必须是对象`);
  requireValue(Object.keys(value).every(key => allowed.includes(key)), `${label} 包含不支持的配置项`);
}

async function readSettingsFile(filename, { optional }) {
  let raw;
  try {
    raw = JSON.parse((await readFile(resolve(filename), 'utf8')).replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (cause.code === 'ENOENT' && optional) return {};
    throw new AutomationError('INVALID_SHARDBROWSER_CONFIG',
      optional ? 'ShardBrowser 配置文件无法读取或不是有效 JSON'
        : `ShardBrowser 配置文件不存在或不是有效 JSON：${filename}`, { cause });
  }
  try {
    assertAllowedKeys(raw, ALLOWED_KEYS, 'shardBrowser 配置文件');
    requireValue(isUnset(raw.endpoint) || typeof raw.endpoint === 'string', 'shardBrowser 配置文件 endpoint 必须是字符串');
    requireValue(isUnset(raw.token) || typeof raw.token === 'string', 'shardBrowser 配置文件 token 必须是字符串');
    requireValue(isUnset(raw.platform) || typeof raw.platform === 'string', 'shardBrowser 配置文件 platform 必须是字符串');
    requireValue(isUnset(raw.timeoutMs) || Number.isInteger(raw.timeoutMs), 'shardBrowser 配置文件 timeoutMs 必须是整数');
    requireValue(isUnset(raw.language) || typeof raw.language === 'string', 'shardBrowser 配置文件 language 必须是字符串');
  } catch (error) {
    // One error code for every malformed credential file, with the field in the message.
    throw new AutomationError('INVALID_SHARDBROWSER_CONFIG', error.message, { cause: error });
  }
  return raw;
}

/**
 * Effective ShardBrowser connection settings.
 * Precedence: main config `shardBrowser` > root credential file > environment.
 * A default root file is optional; an explicitly configured path must exist.
 */
export async function resolveShardBrowserSettings(raw = {}, env = process.env) {
  const configured = raw.shardBrowser ?? {};
  const explicitFile = configured.configFile ?? env.SHARDBROWSER_CONFIG;
  requireValue(isUnset(explicitFile) || typeof explicitFile === 'string', 'shardBrowser.configFile 必须是字符串');
  const filename = isUnset(explicitFile)
    ? DEFAULT_SHARDBROWSER_FILE
    : (isAbsolute(explicitFile) ? explicitFile : resolve(explicitFile));
  const optional = isUnset(explicitFile);
  const file = await readSettingsFile(filename, { optional });

  const pick = (configuredValue, fileValue, envValue, fallback) => {
    if (!isUnset(configuredValue)) return String(configuredValue).trim();
    if (!isUnset(fileValue)) return String(fileValue).trim();
    if (!isUnset(envValue)) return String(envValue).trim();
    return fallback;
  };
  const endpoint = pick(configured.endpoint, file.endpoint,
    env.SHARDBROWSER_ENDPOINT, DEFAULT_ENDPOINT).replace(/\/+$/, '');
  requireValue(/^https?:\/\//.test(endpoint), 'shardBrowser.endpoint 必须是 http(s) 地址');
  const platform = pick(configured.platform, file.platform, undefined, 'Windows');
  const language = pick(configured.language, file.language, env.SHARDBROWSER_LANGUAGE, 'en-US');
  const token = pick(configured.token, file.token,
    env.SHARDBROWSER_TOKEN ?? env.SHARDX_API_TOKEN ?? env.SHARDBROWSER_API_KEY, '');
  const timeoutMs = configured.timeoutMs ?? file.timeoutMs ?? 20000;
  requireValue(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300000,
    'shardBrowser.timeoutMs 必须是 1000–300000 的整数');
  return {
    endpoint, token, platform, timeoutMs, language,
    // Diagnostics only: never echo the token itself.
    tokenSource: !isUnset(configured.token) ? 'config' : !isUnset(file.token) ? 'file' : token ? 'env' : 'none',
    file: optional ? null : filename,
  };
}
