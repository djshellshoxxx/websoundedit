import { test, expect } from '@playwright/test';

async function boot(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.websoundedit?.ready));
  await page.evaluate(() => websoundedit.ready);
  return errors;
}

async function fits(page, container = 'html') {
  const bounds = await page.locator(container).evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth }));
  expect(bounds.scroll, `${container} must not scroll horizontally`).toBeLessThanOrEqual(bounds.width + 1);
}

test('phone and tablet layouts retain readable controls and full-width waveforms', async ({ page }, testInfo) => {
  const errors = await boot(page);
  for (const [width, height] of [[320, 740], [390, 844], [768, 1024], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await fits(page);
    for (const selector of ['#play-button', 'header [data-action="file.import"]', '#inspector-toggle', '[data-action="options"]']) {
      const control = page.locator(selector).first();
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      if (width <= 600) expect(box.height, `${selector} touch height`).toBeGreaterThanOrEqual(44);
    }
    if (width <= 600) {
      expect((await page.locator('.track-waveform').first().boundingBox()).width).toBeGreaterThan(width * .8);
      const size = await page.locator('#selection-start').evaluate(input => parseFloat(getComputedStyle(input).fontSize));
      expect(size, 'avoid focus-triggered iOS text zoom').toBeGreaterThanOrEqual(16);
    }
    await page.screenshot({ path: testInfo.outputPath(`mobile-${width}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});

test('touch selection, zoom, edit and undo work without keyboard shortcuts', async ({ page }) => {
  const errors = await boot(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.track-waveform').first().tap({ position: { x: 70, y: 70 } });
  await page.locator('#selection-start').fill('0.1');
  await page.locator('#selection-end').fill('0.5');
  await page.locator('#selection-end').press('Tab');
  await expect.poll(() => page.evaluate(() => websoundedit.getState().selection?.end)).toBe(.5);
  const before = await page.evaluate(async () => Array.from((await websoundedit.execute('clip.getAudio')).channels[0].slice(0, 30000)));
  await page.locator('[data-action="view.zoomSelection"]').tap();
  await page.locator('[data-action="effect.reverse"]').tap();
  await page.locator('[data-action="history.undo"]').tap();
  const restored = await page.evaluate(async () => Array.from((await websoundedit.execute('clip.getAudio')).channels[0].slice(0, 30000)));
  expect(restored).toEqual(before);
  await expect(page.locator('#feature-guidance')).not.toBeVisible();
  await fits(page);
  expect(errors).toEqual([]);
});

test('Options, Help, macros and export stay usable at 320 pixels', async ({ page }) => {
  const errors = await boot(page);
  await page.setViewportSize({ width: 320, height: 740 });
  const ids = await page.evaluate(() => websoundedit.getState().tracks.map(track => track.id));
  for (const [method, params] of [['ui.options', { page: 'general' }], ['ui.help', { chapter: 'navigation' }], ['ui.macros', {}]]) {
    await page.evaluate(([method, params]) => websoundedit.execute(method, params), [method, params]);
    await expect(page.locator('#workbench-view')).toBeVisible();
    await fits(page, '#workbench-view-body');
    const close = page.locator('[data-view-close]');
    expect((await close.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await close.tap();
    await expect(page.locator('#workbench-view')).not.toBeVisible();
  }
  await page.locator('header [data-action="file.export"]').tap();
  await expect(page.locator('#modal')).toBeVisible();
  await fits(page, '#modal');
  await expect(page.locator('#export-go')).toBeVisible();
  await page.locator('#modal-close').tap();
  expect(await page.evaluate(() => websoundedit.getState().tracks.map(track => track.id))).toEqual(ids);
  expect(errors).toEqual([]);
});
