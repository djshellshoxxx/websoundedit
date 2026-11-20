import { test, expect } from '@playwright/test';

// Only this simulated input-device fixture needs Chromium's fake-media flags.
// Native master recording, OPFS recovery and loop capture run in every engine.
test.use({
  launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--disable-dev-shm-usage', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
  permissions: ['microphone'],
});

test('browser fake microphone starts without monitoring and closes cleanly', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.websoundedit?.ready));
  await page.evaluate(() => websoundedit.ready);
  await page.locator('#play-button').click();
  await page.evaluate(() => websoundedit.execute('audio.input.start', { source: 'microphone', channels: [0], monitor: false }));
  await expect.poll(() => page.evaluate(() => websoundedit.live.getState().input.active)).toBe(true);
  expect(await page.evaluate(() => websoundedit.live.getState().input.monitor)).toBe(false);
  await page.evaluate(() => websoundedit.execute('audio.input.stop'));
  expect(await page.evaluate(() => websoundedit.live.getState().input.active)).toBe(false);
  expect(errors).toEqual([]);
});
