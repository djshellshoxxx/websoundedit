import { test, expect } from '@playwright/test';

async function boot(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.websoundedit?.ready));
  await page.evaluate(() => websoundedit.ready);
  await page.locator('[data-panel="effects"]').click();
  await expect(page.locator('#rack-controls')).toBeVisible();
  return errors;
}

async function add(page, effect) {
  await page.locator('[data-rack-choice]').selectOption(effect);
  await page.locator('[data-rack-add]').click();
}

const effectOrder = page => page.evaluate(() => websoundedit.saveSettings().rack.chain.map(stage => stage.effect));

test('effects rack supports real drag ordering, keyboard reordering, rotary wet/dry and bypass', async ({ page }) => {
  const errors = await boot(page);
  await expect(page.getByText('Build your sound.', { exact: true })).toBeVisible();
  await add(page, 'delay');
  await add(page, 'distortion');
  const stages = page.locator('[data-rack-id]');
  // Keep both ends of the native drag visible. Scrolling an expanded destination
  // into view after mouse-down moves the source away before Chromium starts it.
  await stages.nth(0).locator('summary').click();
  await stages.nth(1).locator('summary').click();
  await stages.nth(1).locator('[data-rack-remove]').scrollIntoViewIfNeeded();
  await expect(stages.nth(0).locator('[data-rack-drag]')).toBeInViewport();
  await stages.nth(0).locator('[data-rack-drag]').dragTo(stages.nth(1).locator('[data-rack-remove]'));
  await expect.poll(() => effectOrder(page)).toEqual(['distortion', 'delay']);
  await stages.nth(0).locator('[data-rack-drag]').focus();
  await page.keyboard.press('End');
  await expect.poll(() => effectOrder(page)).toEqual(['delay', 'distortion']);

  const wet = stages.first().locator('[data-rack-wet]');
  await wet.focus();
  await page.keyboard.press('Home');
  await expect(wet).toHaveAttribute('aria-valuenow', '0');
  expect(await page.evaluate(() => websoundedit.saveSettings().rack.chain[0].wet)).toBe(0);
  await stages.first().locator('[data-rack-wet-number]').fill('27');
  await stages.first().locator('[data-rack-wet-number]').press('Tab');
  await expect(wet).toHaveAttribute('aria-valuenow', '27');
  await stages.first().locator('[data-rack-enable]').click();
  expect(await page.evaluate(() => websoundedit.saveSettings().rack.chain[0].enabled)).toBe(false);
  await expect(stages.first()).toHaveClass(/is-bypassed/);
  await stages.first().locator('[data-rack-down]').click();
  await expect.poll(() => effectOrder(page)).toEqual(['distortion', 'delay']);
  await stages.last().locator('[data-rack-remove]').click();
  await expect(stages).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('XY pad controls two selected parameters, follows reorder, and survives project save/load', async ({ page }, testInfo) => {
  const errors = await boot(page);
  await add(page, 'delay');
  await add(page, 'filter');
  const [delay, filter] = await page.evaluate(() => websoundedit.saveSettings().rack.chain);
  await page.locator('[data-rack-axis="x"]').selectOption(`${delay.id}:wet`);
  await page.locator('[data-rack-axis="y"]').selectOption(`${filter.id}:frequency`);
  const pad = page.locator('[data-rack-xy]');
  await pad.scrollIntoViewIfNeeded();
  const bounds = await pad.boundingBox();
  await page.mouse.move(bounds.x + bounds.width * .25, bounds.y + bounds.height * .25);
  await page.mouse.down();
  await page.mouse.up();
  const pointerResult = await page.evaluate(() => websoundedit.saveSettings().rack);
  expect(pointerResult.chain[0].wet).toBeCloseTo(.25, 1);
  expect(pointerResult.chain[1].params.frequency).toBeGreaterThan(3300);
  expect(pointerResult.chain[1].params.frequency).toBeLessThan(3800);
  await pad.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  const keyboardResult = await page.evaluate(() => websoundedit.saveSettings().rack);
  expect(keyboardResult.chain[0].wet).toBeCloseTo(.01, 5);
  expect(keyboardResult.chain[1].params.frequency).toBeCloseTo(20 * 1000 ** .01, 5);

  const saved = await page.evaluate(async () => {
    const settings = websoundedit.saveSettings();
    await websoundedit.rack.move(settings.rack.chain[0].id, 1);
    const expected = websoundedit.saveSettings().rack;
    const project = await websoundedit.saveProject({ download: false });
    websoundedit.rack.load({ version: 1, chain: [], xy: { x: null, y: null } });
    await websoundedit.loadProject(project);
    return { expected, restored: websoundedit.saveSettings().rack };
  });
  expect(saved.restored).toEqual(saved.expected);
  await expect(page.locator('[data-rack-axis="x"]')).toHaveValue(`${delay.id}:wet`);
  await expect(page.locator('[data-rack-axis="y"]')).toHaveValue(`${filter.id}:frequency`);
  await page.screenshot({ path: testInfo.outputPath('effects-rack-and-xy-desktop.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('rack Apply changes only the selected channel and region and one undo restores PCM', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(async () => {
    await websoundedit.execute('project.new', { sampleRate: 16000, name: 'Rack boundary fixture' });
    await websoundedit.execute('audio.generate', { type: 'tone', frequency: 347, duration: 1, channels: 2, amplitude: .6 });
    await websoundedit.execute('selection.set', { start: .2, end: .8, channels: 'left' });
    window.__rackBefore = await websoundedit.execute('clip.getAudio');
  });
  await add(page, 'stutter');
  await add(page, 'tape');
  await expect(page.locator('#preview-state')).toContainText('preview ready');
  await page.locator('#apply-effect').click();
  const result = await page.evaluate(async () => {
    const before = window.__rackBefore, after = await websoundedit.execute('clip.getAudio');
    let changed = false, outsideSame = true;
    for (let i = 0; i < before.channels[0].length; i++) {
      if (i >= .2 * before.sampleRate && i < .8 * before.sampleRate) changed ||= before.channels[0][i] !== after.channels[0][i];
      else outsideSame &&= before.channels[0][i] === after.channels[0][i];
    }
    const rightSame = before.channels[1].every((value, index) => value === after.channels[1][index]);
    await websoundedit.execute('history.undo');
    const undone = await websoundedit.execute('clip.getAudio');
    return { changed, outsideSame, rightSame, undoSame: before.channels.every((channel, index) => channel.every((value, frame) => value === undone.channels[index][frame])) };
  });
  expect(result).toEqual({ changed: true, outsideSame: true, rightSame: true, undoSame: true });
  expect(errors).toEqual([]);
});

test('rack rejects invalid imported settings atomically and keeps mobile controls inside the viewport', async ({ page }, testInfo) => {
  const errors = await boot(page);
  await add(page, 'filter');
  const validation = await page.evaluate(() => {
    const before = websoundedit.saveSettings();
    const bad = structuredClone(before);
    bad.theme = 'daylight';
    bad.rack.chain[0].params.frequency = '<img src=x onerror=window.__rackExecuted=1>';
    try { websoundedit.loadSettings(bad); return { rejected: false }; }
    catch { return { rejected: true, unchanged: JSON.stringify(websoundedit.saveSettings()) === JSON.stringify(before) }; }
  });
  expect(validation).toEqual({ rejected: true, unchanged: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-rack-wet]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.locator('[data-rack-param="frequency"][type="number"]').fill('99999');
  await page.locator('[data-rack-param="frequency"][type="number"]').press('Tab');
  await expect(page.locator('[data-rack-param="frequency"][type="number"]')).toHaveValue('1200');
  expect(await page.evaluate(() => websoundedit.saveSettings().rack.chain[0].params.frequency)).toBe(1200);
  await page.screenshot({ path: testInfo.outputPath('effects-rack-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});
