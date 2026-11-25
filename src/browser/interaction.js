import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// 随机整数
const sample = range =>
  randomInt(range.min, range.max + 1);

// 延迟范围校验
function validateRange(name, range) {
  if (
    !range ||
    !Number.isSafeInteger(range.min) ||
    !Number.isSafeInteger(range.max) ||
    range.min < 0 ||
    range.max < range.min
  ) {
    throw new TypeError(`Invalid delay range: ${name}`);
  }
}

export function createInteraction(
  config,
  { signal, log = () => {} } = {}
) {
  // 检查配置
  for (const key of [
    'fieldDelayMs',
    'submitDelayMs',
    'keyDelayMs',
  ]) {
    validateRange(key, config[key]);
  }

  // 中断检查
  const checkAbort = () => {
    signal?.throwIfAborted();
  };

  // 统一随机等待
  const pause = async (range, stage, field) => {
    checkAbort();

    const durationMs = sample(range);

    log('interaction_delay', {
      stage,
      field,
      durationMs,
    });

    if (durationMs > 0) {
      await delay(durationMs, undefined, { signal });
    }
  };

  // 短暂操作停顿；测试将延迟范围设为 0 时不额外阻塞
  const microPause = async (minMs, maxMs) => {
    checkAbort();
    if (config.fieldDelayMs.max === 0 && config.keyDelayMs.max === 0) return;
    const ms = randomInt(minMs, maxMs + 1);
    if (ms > 0) await delay(ms, undefined, { signal });
  };

  // 分步移动鼠标至目标框内随机点，再执行真实点击
  const clickElement = async (locator, options = {}) => {
    const { timeout } = options;
    checkAbort();
    if (typeof locator.scrollIntoViewIfNeeded === 'function') {
      await locator.scrollIntoViewIfNeeded(timeout ? { timeout } : undefined).catch(() => {});
    }
    const box = typeof locator.boundingBox === 'function'
      ? await locator.boundingBox(timeout ? { timeout } : undefined).catch(() => null)
      : null;
    if (box && box.width > 6 && box.height > 4) {
      const offsetX = Math.round(box.width * (0.22 + (randomInt(0, 57) / 100)));
      const offsetY = Math.round(box.height * (0.28 + (randomInt(0, 45) / 100)));
      const page = typeof locator.page === 'function' ? locator.page() : null;
      if (page?.mouse?.move) {
        await page.mouse.move(box.x + offsetX, box.y + offsetY, { steps: randomInt(8, 17) }).catch(() => {});
        await microPause(45, 130);
      }
      await locator.click({ ...(timeout ? { timeout } : {}), position: { x: offsetX, y: offsetY } });
    } else {
      await locator.click(timeout ? { timeout } : undefined);
    }
    await microPause(60, 160);
  };

  return {

    // 字段操作之前等待
    beforeField: field =>
      pause(config.fieldDelayMs, 'fill', field),

    // 下拉选项操作之前等待
    beforeOption: field =>
      pause(config.fieldDelayMs, 'select_option', field),

    // 提交之前等待
    beforeSubmit: () =>
      pause(config.submitDelayMs, 'submit', 'submit'),

    // 真实移动并点击
    click: clickElement,

    // 自然短暂停顿
    settle: () => microPause(120, 280),

    // 随机键盘输入
    async typeText(locator, value, options = {}) {
      const {
        field = 'input',
        clear = true,
        clearMode = 'fill',
        click = false,
      } = options;

      checkAbort();

      if (click) {
        await clickElement(locator);
      } else {
        // 下拉组合框由调用方负责点击展开，此处仅聚焦
        await locator.focus();
      }

      // 仅当输入框已有内容时清空，避免对空框派发合成 fill('') 事件
      const currentValue = typeof locator.inputValue === 'function'
        ? await locator.inputValue().catch(() => '')
        : '';
      if (clear && currentValue.length > 0) {
        if (clearMode === 'keyboard') {
          await locator.press('ControlOrMeta+A');
          await microPause(35, 90);
          await locator.press('Backspace');
        } else if (clearMode === 'fill') {
          await locator.fill('');
        } else {
          throw new TypeError(`Invalid clearMode: ${clearMode}`);
        }
      }

      // 按 Unicode 字符遍历
      const characters = Array.from(
        String(value ?? '').replace(/\r\n?/g, '\n')
      );

      for (let i = 0; i < characters.length; i++) {
        checkAbort();

        const character = characters[i];

        // 输入当前字符
        if (character === '\n') {
          await locator.press('Enter');
        } else {
          await locator.pressSequentially(character);
        }

        // 每个字符之间随机等待
        if (i < characters.length - 1) {
          await pause(
            config.keyDelayMs,
            'type',
            field
          );
        }
      }

      log('interaction_typed', {
        field,
        characterCount: characters.length,
      });
    },
  };
}
