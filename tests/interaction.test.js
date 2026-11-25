import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInteraction } from '../src/browser/interaction.js';
import { forceEnglishForm } from '../src/apps/sheerid/language.js';

function fakeLocator(initialValue = '', box = { x: 100, y: 200, width: 200, height: 40 }) {
  const calls = [];
  const mouseMoves = [];
  const page = {
    mouse: {
      move: async (x, y, opts) => {
        mouseMoves.push({ x, y, steps: opts?.steps ?? 1 });
        calls.push(['move', { x, y, steps: opts?.steps ?? 1 }]);
      },
    },
  };
  return {
    calls,
    mouseMoves,
    page: () => page,
    scrollIntoViewIfNeeded: async () => { calls.push(['scroll']); },
    boundingBox: async () => box,
    click: async opts => { calls.push(['click', opts ?? null]); },
    focus: async () => { calls.push(['focus']); },
    inputValue: async () => initialValue,
    fill: async val => { calls.push(['fill', val]); },
    pressSequentially: async ch => { calls.push(['type', ch]); },
    press: async key => { calls.push(['press', key]); },
  };
}

test('typeText moves mouse in steps, clicks with bounded coordinates, and skips empty fill', async () => {
  const interaction = createInteraction({
    keyDelayMs: { min: 0, max: 0 },
    fieldDelayMs: { min: 0, max: 0 },
    submitDelayMs: { min: 0, max: 0 },
  });

  const emptyField = fakeLocator('');
  await interaction.typeText(emptyField, 'ab', { click: true, clearMode: 'keyboard' });
  assert.equal(emptyField.calls[0][0], 'scroll');
  assert.equal(emptyField.calls[1][0], 'move');
  assert.ok(emptyField.mouseMoves[0].steps >= 8, `expected multi-step move, got ${emptyField.mouseMoves[0].steps}`);
  assert.equal(emptyField.calls[2][0], 'click');
  const pos = emptyField.calls[2][1]?.position;
  assert.ok(pos && pos.x >= 44 && pos.x <= 156, `expected bounded click x, got ${pos?.x}`);
  assert.ok(pos && pos.y >= 11 && pos.y <= 29, `expected bounded click y, got ${pos?.y}`);
  assert.equal(emptyField.mouseMoves[0].x, 100 + pos.x);
  assert.equal(emptyField.mouseMoves[0].y, 200 + pos.y);
  assert.equal(emptyField.calls.some(c => c[0] === 'fill'), false, 'must not emit fill("") on empty input');
  assert.deepEqual(emptyField.calls.slice(3), [['type', 'a'], ['type', 'b']]);

  const populatedField = fakeLocator('existing');
  await interaction.typeText(populatedField, 'x', { click: true, clearMode: 'keyboard' });
  assert.ok(populatedField.calls.some(c => c[0] === 'press' && c[1] === 'ControlOrMeta+A'));
  assert.ok(populatedField.calls.some(c => c[0] === 'press' && c[1] === 'Backspace'));

  const combobox = fakeLocator('old');
  await interaction.typeText(combobox, 'x', { click: false });
  assert.deepEqual(combobox.calls, [['focus'], ['fill', ''], ['type', 'x']]);
});

test('forceEnglishForm exits with PAGE_CLOSED instead of spinning when page closes', async () => {
  let closed = false;
  let retries = 0;
  const page = {
    isClosed: () => closed,
    waitForSelector: async () => ({}),
    locator: () => ({
      inputValue: async () => '中文（繁体）',
      click: async () => {
        closed = true;
        throw new Error('locator.click: Target page, context or browser has been closed');
      },
    }),
    keyboard: { press: async () => {} },
  };
  await assert.rejects(
    forceEnglishForm(page, {
      timeoutMs: 5000,
      log: event => { if (event === 'form_language_switch_retry') retries += 1; },
    }),
    { code: 'PAGE_CLOSED' },
  );
  assert.equal(retries, 0);
});
