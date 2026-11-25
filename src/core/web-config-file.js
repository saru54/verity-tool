import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AutomationError } from './errors.js';

export const DEFAULT_WEB_CONFIG = resolve('config/sheerid.local.json');
export const EXAMPLE_WEB_CONFIG = resolve('config/sheerid.example.json');

/**
 * Boot the web workspace even on a fresh checkout: when the local config is
 * missing, seed it from the committed example instead of failing the start.
 * A broken (invalid JSON) file is never overwritten — that would destroy an
 * operator's settings.
 */
export async function ensureWebConfigFile(configFile = DEFAULT_WEB_CONFIG,
  { exampleFile = EXAMPLE_WEB_CONFIG } = {}) {
  let text;
  try {
    text = await readFile(configFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new AutomationError('INVALID_CONFIG', `无法读取配置文件：${resolve(configFile)}`, { cause: error });
    }
    try {
      await mkdir(dirname(resolve(configFile)), { recursive: true });
      await copyFile(exampleFile, configFile);
      text = await readFile(configFile, 'utf8');
    } catch (copyError) {
      throw new AutomationError('CONFIG_MISSING',
        `配置文件不存在：${resolve(configFile)}；请复制 ${exampleFile} 为该路径后重试`, { cause: copyError });
    }
    try {
      const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      return { raw: parsed, created: true, configFile: resolve(configFile) };
    } catch (cause) {
      throw new AutomationError('INVALID_CONFIG',
        `已从示例生成配置文件但内容不是有效 JSON：${resolve(configFile)}`, { cause });
    }
  }
  try {
    return { raw: JSON.parse(text.replace(/^\uFEFF/, '')), created: false, configFile: resolve(configFile) };
  } catch (cause) {
    throw new AutomationError('INVALID_CONFIG',
      `配置文件不是有效 JSON：${resolve(configFile)}（不支持注释和尾随逗号）`, { cause });
  }
}
