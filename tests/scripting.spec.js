import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { encodeWav, decodeWav } from '../src/wav.js';

async function boot(page) {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.waitForFunction(() => Boolean(window.websoundedit?.ready)); await page.evaluate(() => websoundedit.ready);
  return errors;
}

test('example library runs nested arrays and seeded random tools and exposes a complete result', async ({ page }) => {
  const errors = await boot(page);
  await page.locator('[data-action="macros"]').click();
  await page.locator('#macro-example').selectOption('array-workbench');
  await page.locator('#macro-use-example').click();
  await expect(page.locator('#macro-source')).toContainText('array.shuffle');
  await page.locator('#macro-run').click();
  await expect(page.locator('[data-macro-progress]')).toContainText('Complete');
  await page.getByText('Run result and variables', { exact: true }).click();
  await expect(page.locator('#macro-run-result')).toContainText('"count": 6');
  const file = page.waitForEvent('download'); await page.locator('#macro-download-result').click();
  const result = JSON.parse(await readFile(await (await file).path(), 'utf8'));
  expect(result.variables.rows).toHaveLength(6); expect(result.variables.rows.every(row => row.length === 3)).toBe(true);
  const repeated = await page.evaluate(async () => {
    const text = 'random.seed({seed:19}); let n=random.float({});';
    return [(await websoundedit.execute('macro.run', { text })).variables.n, (await websoundedit.execute('macro.run', { text })).variables.n];
  });
  expect(repeated[0]).toBe(repeated[1]);
  await page.locator('a[href="#macros/reference"]').first().click();
  await page.locator('#macro-tool-search').fill('shuffle');
  await expect(page.locator('[data-macro-tool]:visible')).toHaveCount(1);
  await expect(page.locator('[data-macro-tool]:visible')).toContainText('array.shuffle');
  expect(errors).toEqual([]);
});

test('quick batch converter normalizes two real WAVs, preserves stereo and restores the project and draft', async ({ page }, testInfo) => {
  const errors = await boot(page);
  const before = await page.evaluate(async () => ({ project: await websoundedit.saveProject({ download: false }), draft: websoundedit.saveSettings().macros.draft }));
  await page.locator('[data-action="macros"]').click(); await page.locator('a[href="#macros/batch"]').click();
  await page.locator('#batch-mode').selectOption('convert');
  await expect(page.locator('#batch-format option')).toHaveCount(10);
  await page.locator('#batch-format').selectOption('wav'); await page.locator('#batch-normalize').check();
  const source = { sampleRate: 8000, channels: [new Float32Array(800).fill(.2), new Float32Array(800).fill(-.1)] };
  await page.locator('#batch-files').setInputFiles([
    { name: 'first.wav', mimeType: 'audio/wav', buffer: Buffer.from(encodeWav(source)) },
    { name: 'second.wav', mimeType: 'audio/wav', buffer: Buffer.from(encodeWav(source)) },
  ]);
  await page.locator('#batch-run').click();
  await expect(page.locator('[data-macro-progress]')).toContainText('Batch complete: 2/2 succeeded');
  await expect(page.locator('#macro-batch-download')).toBeEnabled();
  const file = page.waitForEvent('download'); await page.locator('#macro-batch-download').click();
  const entries = unzipSync(new Uint8Array(await readFile(await (await file).path())));
  expect(Object.keys(entries).sort()).toEqual(['first.wav', 'second.wav']);
  for (const bytes of Object.values(entries)) {
    const decoded = decodeWav(bytes); expect(decoded.channels).toHaveLength(2);
    expect(decoded.channels[0][100]).toBeCloseTo(10 ** (-1 / 20), 3); expect(decoded.channels[1][100]).toBeLessThan(0);
  }
  const after = await page.evaluate(async () => ({ project: await websoundedit.saveProject({ download: false }), draft: websoundedit.saveSettings().macros.draft }));
  expect(after).toEqual(before);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('quick-batch-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});
