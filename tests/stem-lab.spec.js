import { test, expect } from '@playwright/test';
import { encodeWav } from '../src/wav.js';

function wavFile(name = 'short.wav', { sampleRate = 8000, seconds = .1, channels = 2, amplitude = .2 } = {}) {
  const frames = Math.round(sampleRate * seconds);
  const audio = {
    sampleRate,
    channels: Array.from({ length: channels }, (_, channel) => Float32Array.from({ length: frames }, (_, index) => amplitude * Math.sin(2 * Math.PI * (220 + channel * 110) * index / sampleRate))),
    ...(channels === 6 ? { layout: '5.1' } : {}),
  };
  return { name, mimeType: 'audio/wav', buffer: Buffer.from(encodeWav(audio, { bitDepth: 32, float: true })) };
}

async function openLab(page) {
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  await page.goto('/stem-lab.html');
  await expect(page.locator('#model-size')).toHaveText('165.6 MB');
  return { errors, requests };
}

test('stem prototype is explicit, stays idle without a model and fits a 320px screen', async ({ page }) => {
  const { errors, requests } = await openLab(page);
  await expect(page).toHaveTitle('Neural stem isolation · prototype | WebSoundEdit');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Neural stem isolation · prototype');
  await expect(page.getByRole('button', { name: 'Load model', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Separate stems', exact: true })).toBeDisabled();
  await expect(page.locator('#stem-results')).toBeHidden();
  await expect(page.locator('#original-preview')).toBeHidden();
  await expect(page.getByRole('link', { name: 'model card', exact: true })).toHaveAttribute('href', /huggingface\.co\/StemSplitio\/htdemucs-onnx\/blob\/[a-f0-9]{40}\/README\.md$/);
  const currentOrigin = new URL(page.url()).origin;
  expect(requests.every(request => request.method === 'GET' && new URL(request.url).origin === currentOrigin)).toBe(true);
  expect(requests.some(request => /\.onnx(?:\?|$)|\.wasm(?:\?|$)/.test(request.url))).toBe(false);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#stem-model-file')).toBeVisible();
  await expect(page.locator('#stem-audio-file')).toBeVisible();
  expect(errors).toEqual([]);
});

test('unsupported model is rejected without loading inference assets', async ({ page }) => {
  const { errors, requests } = await openLab(page);
  await page.locator('#stem-model-file').setInputFiles({ name: 'unrelated.onnx', mimeType: 'application/octet-stream', buffer: Buffer.alloc(128) });
  await expect(page.getByRole('alert')).toContainText('different size');
  await expect(page.locator('#model-status')).toContainText('Unsupported model file');
  await expect(page.locator('#stem-load-model')).toBeDisabled();
  await expect(page.locator('#stem-separate')).toBeDisabled();
  expect(requests.some(request => /\.onnx(?:\?|$)|\.wasm(?:\?|$)/.test(request.url))).toBe(false);
  expect(errors).toEqual([]);
});

test('a valid WAV is resampled locally and previewed but cannot separate without a verified model', async ({ page }) => {
  const { errors, requests } = await openLab(page);
  await page.locator('#stem-audio-file').setInputFiles(wavFile('source <test>.wav'));
  await expect(page.locator('#source-status')).toContainText('0.100 s · stereo · 8,000 Hz resampled to 44.1 kHz');
  await expect(page.locator('#source-status')).toContainText('source <test>.wav');
  await expect(page.locator('#original-preview')).toBeVisible();
  await expect.poll(() => page.locator('#original-player').evaluate(player => player.duration)).toBeCloseTo(.1, 3);
  await expect(page.locator('#stem-separate')).toBeDisabled();
  await expect(page.locator('#stem-status')).toHaveText('Source ready. Load the supported model to continue.');
  await expect(page.locator('#stem-results')).toBeHidden();
  expect(requests.every(request => request.method === 'GET')).toBe(true);
  expect(requests.filter(request => /^https?:/.test(request.url)).every(request => new URL(request.url).origin === new URL(page.url()).origin)).toBe(true);
  expect(errors).toEqual([]);
});

test('invalid, long, surround and over-full-scale WAVs cannot become inference input', async ({ page }) => {
  const { errors } = await openLab(page);
  await page.locator('#stem-audio-file').setInputFiles({ name: 'invalid.wav', mimeType: 'audio/wav', buffer: Buffer.from('This is not a WAV') });
  await expect(page.getByRole('alert')).toContainText('WAVE');
  await expect(page.locator('#original-preview')).toBeHidden();
  await page.locator('#stem-audio-file').setInputFiles(wavFile('too-long.wav', { seconds: 31 }));
  await expect(page.getByRole('alert')).toHaveText('Choose a WAV no longer than 30 seconds.');
  await expect(page.locator('#original-preview')).toBeHidden();
  await page.locator('#stem-audio-file').setInputFiles(wavFile('surround.wav', { channels: 6 }));
  await expect(page.getByRole('alert')).toHaveText('Choose a mono or stereo WAV. The channel limit is 2.');
  await page.locator('#stem-audio-file').setInputFiles(wavFile('too-loud.wav', { amplitude: 1.5 }));
  await expect(page.getByRole('alert')).toContainText('Normalize to -1 dBFS');
  await expect(page.locator('#source-status')).toContainText('Source not loaded');
  await expect(page.locator('#stem-separate')).toBeDisabled();
  await expect(page.locator('#stem-results')).toBeHidden();
  await expect(page.locator('#original-preview')).toBeHidden();
  expect(errors).toEqual([]);
});

test('cancelling source preparation prevents a stale read from replacing the next input', async ({ page }) => {
  // Only delay file I/O. This verifies the UI lifecycle, not model inference.
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== 'delayed.wav') return read.call(this);
      const file = this;
      return new Promise((resolve, reject) => { window.releaseDelayedWav = () => read.call(file).then(resolve, reject); });
    };
  });
  const { errors } = await openLab(page);
  await page.locator('#stem-audio-file').setInputFiles(wavFile('delayed.wav'));
  await expect(page.locator('#stem-cancel')).toBeEnabled();
  await page.locator('#stem-cancel').click();
  await expect(page.locator('#source-status')).toContainText('cancelled');
  await expect(page.locator('#stem-audio-file')).toBeEnabled();
  await page.locator('#stem-audio-file').setInputFiles(wavFile('next.wav', { sampleRate: 44100, channels: 1, seconds: .2 }));
  await expect(page.locator('#source-status')).toContainText('next.wav · 0.200 s · mono');
  await page.evaluate(() => window.releaseDelayedWav());
  await expect(page.locator('#source-status')).toContainText('next.wav · 0.200 s · mono');
  await expect.poll(() => page.locator('#original-player').evaluate(player => player.duration)).toBeCloseTo(.2, 3);
  await expect(page.locator('#stem-error')).toBeHidden();
  await expect(page.locator('#stem-separate')).toBeDisabled();
  expect(errors).toEqual([]);
});
