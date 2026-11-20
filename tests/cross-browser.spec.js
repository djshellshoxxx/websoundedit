import { test, expect } from '@playwright/test';

async function boot(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.websoundedit?.ready));
  await page.evaluate(() => websoundedit.ready);
  return errors;
}

test('real audio worklets capture an audible loop and keep live parameter changes running', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(async () => {
    await websoundedit.execute('project.new', { name: 'Browser audio verification', sampleRate: 48000, bpm: 120 });
    await websoundedit.execute('audio.generate', { duration: 2, frequency: 220, amplitude: .2, channels: 2 });
    await websoundedit.execute('live.rack.set', { chain: [{ id: 'browser-delay', effect: 'delay', wet: .25, params: { timeMs: 30, feedback: .2 } }] });
  });
  await page.locator('#play-button').click();
  await expect.poll(() => page.evaluate(() => websoundedit.live.getState().transport.playing)).toBe(true);
  await page.evaluate(() => websoundedit.execute('loop.capture.start', { source: 'master', beats: .25, quantize: 'off' }));
  await expect.poll(() => page.evaluate(() => websoundedit.live.getState().loops.length)).toBe(1);
  const audio = await page.evaluate(async () => {
    const loop = websoundedit.live.getState().loops[0];
    const pcm = await websoundedit.execute('clip.getAudio', { clipId: loop.clipId });
    await websoundedit.execute('live.param.set', { slotId: 'browser-delay', param: 'wet', value: .5, rampMs: 20 });
    const result = { frames: pcm.channels[0].length, rate: pcm.sampleRate, channels: pcm.channels.length,
      peak: pcm.channels[0].reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0),
      playing: websoundedit.live.getState().transport.playing };
    await websoundedit.execute('loop.track.remove', { trackId: loop.trackId });
    await websoundedit.execute('transport.stop');
    return result;
  });
  expect(audio.frames / audio.rate).toBeCloseTo(.125, 4);
  expect(audio.channels).toBe(2);
  expect(audio.peak).toBeGreaterThan(.005);
  expect(audio.playing).toBe(true);
  expect(errors).toEqual([]);
});

test('repeated worker edits and project round trips preserve PCM while the UI remains responsive', async ({ page }, testInfo) => {
  const errors = await boot(page);
  const result = await page.evaluate(async () => {
    await websoundedit.execute('project.new', { sampleRate: 48000 });
    await websoundedit.execute('audio.generate', { duration: 2, frequency: 333, channels: 2 });
    const original = await websoundedit.execute('clip.getAudio');
    let heartbeats = 0;
    const interval = setInterval(() => heartbeats++, 10), started = performance.now();
    try {
      for (let i = 0; i < 40; i++) {
        await websoundedit.execute('effect.gain', { db: -3 });
        await websoundedit.execute('history.undo');
      }
      for (let i = 0; i < 5; i++) await websoundedit.loadProject(await websoundedit.saveProject({ download: false }));
      const pcm = await websoundedit.execute('clip.getAudio');
      return { edits: 80, projectRoundTrips: 5, heartbeats, elapsedMs: performance.now() - started,
        same: pcm.channels.every((channel, c) => channel.every((value, i) => value === original.channels[c][i])),
        tracks: websoundedit.getState().tracks.length };
    } finally { clearInterval(interval); }
  });
  expect(result.same).toBe(true);
  expect(result.tracks).toBe(1);
  expect(result.heartbeats).toBeGreaterThan(2);
  await testInfo.attach('browser-stress.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(errors).toEqual([]);
});

test('missing output-device and system-capture APIs leave usable, truthful controls', async ({ page }) => {
  await page.addInitScript(() => {
    if (globalThis.AudioContext) Object.defineProperty(AudioContext.prototype, 'setSinkId', { configurable: true, value: undefined });
    if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: undefined });
  });
  const errors = await boot(page);
  await page.evaluate(() => websoundedit.execute('ui.options', { page: 'output' }));
  await expect(page.locator('#output-device')).toBeDisabled();
  await expect(page.locator('#options-content')).toContainText('system default output');
  const capabilities = await page.evaluate(() => websoundedit.execute('audio.capabilities'));
  expect(capabilities.outputSelection).toBe(false);
  expect(capabilities.displayInput).toBe(false);
  await page.locator('[data-view-close]').click();
  await page.locator('#play-button').click();
  await expect.poll(() => page.evaluate(() => websoundedit.live.getState().transport.playing)).toBe(true);
  await page.locator('[data-action="transport.stop"]').click();
  expect(errors).toEqual([]);
});
