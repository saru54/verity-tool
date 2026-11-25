import { setTimeout as delay } from 'node:timers/promises';
import { AutomationError } from '../../core/errors.js';

// SheerID renders its form in the campaign's language, which can differ from the
// browser locale (a Chinese campaign on an en-US browser renders 德国 for Germany).
// The language widget itself is React-rendered late, so "not visible yet" must
// never be read as "this campaign has no selector".
const WIDGET = '#changeLanguageSelector-input';

export async function forceEnglishForm(page, { log = () => {}, timeoutMs = 30000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  // The selector appears with the form, a beat after the fields do. Wait for it
  // instead of snapshotting isVisible() once; a "no-selector" here silently
  // leaves a Chinese form behind and the country step then fails.
  const appeared = await page.waitForSelector(WIDGET, {
    state: 'visible', timeout: Math.max(1000, Math.min(15000, timeoutMs)), signal,
  }).catch(() => null);
  if (page.isClosed?.()) throw new AutomationError('PAGE_CLOSED', '切换表单语言期间浏览器页面已关闭');
  if (!appeared) return { switched: false, reason: 'no-selector' };
  let attempts = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (page.isClosed?.()) throw new AutomationError('PAGE_CLOSED', '切换表单语言期间浏览器页面已关闭');
    const selector = page.locator(WIDGET);
    const current = await selector.inputValue().catch(() => '');
    if (/^English/i.test(current.trim())) {
      return { switched: attempts > 0, reason: attempts > 0 ? 'selector' : 'already-english' };
    }
    attempts += 1;
    log('form_language_switch_started', { stage: 'wait_ready', from: current });
    try {
      // The readonly combobox input intercepts pointer events from the toggle
      // button; clicking the input itself opens the listbox reliably.
      await selector.click({ timeout: 5000 });
      const english = page.getByRole('option', { name: /^English$/i }).first();
      await english.waitFor({ state: 'visible', timeout: 5000 });
      await english.click({ timeout: 5000 });
    } catch (error) {
      signal?.throwIfAborted();
      if (page.isClosed?.() || /has been closed/i.test(error?.message ?? '')) {
        throw new AutomationError('PAGE_CLOSED', '切换表单语言期间浏览器页面已关闭', { cause: error });
      }
      log('form_language_switch_retry', { stage: 'wait_ready', attempt: attempts });
      await page.keyboard.press('Escape').catch(() => {});
      await delay(Math.min(800, Math.max(1, deadline - Date.now())), undefined, { signal });
      continue;
    }
    // The form re-renders in place; wait until the selector reports English.
    try {
      await page.waitForFunction(() => /^English/i.test((document.querySelector('#changeLanguageSelector-input')?.value ?? '').trim()), undefined, { timeout: 15000, signal });
      log('form_language_switched', { stage: 'wait_ready', to: 'English', attempt: attempts });
      return { switched: true, reason: 'selector' };
    } catch { /* value did not settle; retry the whole sequence */ }
    await page.keyboard.press('Escape').catch(() => {});
  }
  log('form_language_switch_failed', { stage: 'wait_ready', attempts });
  return { switched: false, reason: 'timeout' };
}

export function formIsEnglish(page) {
  return page.evaluate(() => {
    const value = document.querySelector('#changeLanguageSelector-input')?.value ?? '';
    // No selector on this campaign: rely on the rendered country placeholder.
    if (!value) return true;
    return /^English/i.test(value.trim());
  });
}
