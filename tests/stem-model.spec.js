import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { encodeWav, decodeWav } from '../src/wav.js';
import { stemFixture } from './stem-fixture.js';
import { STEM_MODEL } from '../src/stems/model.js';

// Uploaded model bytes must never become part of a trace artifact.
test.use({ trace: 'off' });

// The regular suite does not obtain weights. A caller must supply the exact
// local research model to opt into this expensive, genuine inference check.
test('the pinned neural model produces downloadable stems from centered mono audio', async ({ page }, testInfo) => {
  test.skip(!process.env.WSE_STEM_MODEL_PATH, 'Set WSE_STEM_MODEL_PATH to the supported local model for real inference.');
  test.setTimeout(12 * 60_000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  await page.goto('/stem-lab.html');
  await expect(page.locator('#model-size')).toHaveText('165.6 MB');
  const source = stemFixture();
  await page.locator('#stem-audio-file').setInputFiles({ name: 'centered-synthetic.wav', mimeType: 'audio/wav', buffer: Buffer.from(encodeWav(source, { bitDepth: 32, float: true })) });
  await expect(page.locator('#source-status')).toContainText('9.000 s · mono');
  await page.locator('#stem-model-file').setInputFiles(process.env.WSE_STEM_MODEL_PATH);
  const started = Date.now();
  await page.locator('#stem-load-model').click();
  await expect(page.locator('#model-status')).toContainText('verified and ready', { timeout: 180_000 });
  const loaded = Date.now();
  await page.locator('#stem-separate').click();
  await expect(page.locator('#stem-results')).toBeVisible({ timeout: 600_000 });
  await expect(page.locator('.stem-card')).toHaveCount(5);
  const finished = Date.now(), outputs = {};
  for (const name of ['vocals', 'instrumental', 'drums', 'bass', 'other']) {
    const card = page.locator(`[data-stem="${name}"]`);
    const [download] = await Promise.all([page.waitForEvent('download'), card.locator('a[download]').click()]);
    expect(download.suggestedFilename()).toBe(`centered-synthetic-${name}.wav`);
    const audio = decodeWav(await readFile(await download.path()));
    expect(audio.sampleRate).toBe(STEM_MODEL.sampleRate);
    expect(audio.channels).toHaveLength(2);
    expect(audio.channels[0]).toHaveLength(source.channels[0].length);
    let peak = 0, sum = 0, finite = true;
    for (const channel of audio.channels) for (const value of channel) {
      finite &&= Number.isFinite(value);
      peak = Math.max(peak, Math.abs(value)); sum += value * value;
    }
    expect(finite, `${name} samples must all be finite`).toBe(true);
    outputs[name] = { frames: audio.channels[0].length, peak, rms: Math.sqrt(sum / (audio.channels[0].length * 2)) };
  }
  expect(outputs.instrumental.rms).toBeGreaterThan(1e-8);
  expect(outputs.bass.rms).not.toBe(outputs.drums.rms);
  const origin = new URL(page.url()).origin;
  expect(requests.filter(request => /^https?:/.test(request.url)).every(request => request.method === 'GET' && new URL(request.url).origin === origin)).toBe(true);
  expect(errors).toEqual([]);
  await page.locator('#stem-release').click();
  await expect(page.locator('#stem-separate')).toBeDisabled();
  await expect(page.locator('.stem-card')).toHaveCount(5);
  await testInfo.attach('real-model-execution.json', {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ modelId: STEM_MODEL.id, modelSha256: STEM_MODEL.sha256, userAgent: await page.evaluate(() => navigator.userAgent), loadMs: loaded - started, separationMs: finished - loaded, source: '9-second centered synthetic instruments, not a perceptual quality benchmark', outputs }, null, 2)),
  });
});
