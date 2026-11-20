import { test, expect } from '@playwright/test';

async function boot(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.websoundedit?.ready));
  await page.evaluate(() => websoundedit.ready);
  await page.evaluate(async () => {
    await websoundedit.execute('project.new', { name: 'Precision editing', sampleRate: 8000 });
    const left = Float32Array.from({ length: 1600 }, (_, frame) => Math.floor(frame / 400) % 2 ? -.2 : .2);
    await websoundedit.execute('clip.add', { name: 'Stereo fixture', start: 1, audio: { sampleRate: 8000, channels: [left, left.map(value => -value * .5)] } });
  });
  return errors;
}

test('precision editing tools insert silence, find shared zero crossings and extract editable mono tracks', async ({ page }) => {
  const errors = await boot(page);
  await page.locator('[data-action="edit.insertSilence"]').click();
  await expect(page.getByRole('dialog', { name: 'Insert silence' })).toBeVisible();
  await page.locator('#silence-at').fill('.05');
  await page.locator('#silence-duration').fill('.025');
  await page.locator('#insert-silence-form').getByRole('button', { name: 'Insert silence', exact: true }).click();
  await expect(page.locator('#modal')).not.toBeVisible();
  const inserted = await page.evaluate(async () => {
    const state = websoundedit.getState(), audio = await websoundedit.execute('clip.getAudio');
    return { frames: audio.channels[0].length, silent: audio.channels.every(channel => channel.slice(400, 600).every(sample => sample === 0)), selection: state.selection };
  });
  expect(inserted.frames).toBe(1800); expect(inserted.silent).toBe(true);
  expect(inserted.selection.start).toBe(.05); expect(inserted.selection.end).toBe(.075);
  await page.locator('[data-action="history.undo"]').click();
  await expect.poll(() => page.evaluate(() => websoundedit.getState().tracks[0].clips[0].frames)).toBe(1600);

  await page.evaluate(() => websoundedit.execute('selection.set', { start: 396 / 8000, end: 796 / 8000, channels: 'all' }));
  await page.locator('[data-action="selection.zeroCrossing"]').click();
  await page.locator('#zero-crossing-radius').fill('1');
  await page.locator('#zero-crossing-form').getByRole('button', { name: 'Snap selection' }).click();
  await expect(page.locator('#modal')).not.toBeVisible();
  const snapped = await page.evaluate(() => websoundedit.getState().selection);
  expect(snapped.start).toBe(.05); expect(snapped.end).toBe(.1);

  await page.locator('[data-action="clip.extractChannels"]').click();
  await expect(page.getByRole('dialog', { name: 'Extract channels to mono tracks' })).toContainText('New tracks start muted');
  await page.locator('#extract-channels-confirm').click();
  await expect(page.locator('#modal')).not.toBeVisible();
  const extracted = await page.evaluate(() => websoundedit.getState());
  expect(extracted.tracks).toHaveLength(3);
  expect(extracted.tracks.slice(1).map(track => track.mute)).toEqual([true, true]);
  expect(extracted.tracks.slice(1).map(track => track.clips[0].channels)).toEqual([1, 1]);
  expect(extracted.tracks.slice(1).map(track => track.clips[0].start)).toEqual([1, 1]);
  await page.locator('[data-action="history.undo"]').click();
  await expect.poll(() => page.evaluate(() => websoundedit.getState().tracks.length)).toBe(1);
  expect(errors).toEqual([]);
});

test('noise gate controls preview, apply, undo and retain linked or independent detector settings', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(async () => {
    await websoundedit.execute('project.new', { sampleRate: 8000 });
    await websoundedit.execute('clip.add', { audio: { sampleRate: 8000, channels: [new Float32Array(800).fill(.001), new Float32Array(800).fill(.4)] } });
  });
  await page.locator('[data-panel="effects"]').click();
  await page.locator('[data-rack-choice]').selectOption('noiseGate');
  await page.locator('[data-rack-add]').click();
  await page.locator('[data-rack-param="channelMode"]').selectOption('independent');
  await page.locator('[data-rack-param="thresholdDb"][type="number"]').fill('-20');
  await page.locator('[data-rack-param="thresholdDb"][type="number"]').press('Tab');
  await expect(page.locator('#preview-state')).toContainText('preview ready');
  await page.locator('#apply-effect').click();
  await expect(page.locator('#status')).toContainText('applied');
  const changed = await page.evaluate(async () => {
    const audio = await websoundedit.execute('clip.getAudio');
    return { quiet: Math.max(...audio.channels[0]), loud: audio.channels[1][799], detector: websoundedit.saveSettings().rack.chain[0].params.channelMode };
  });
  expect(changed.quiet).toBeLessThan(1e-6); expect(changed.loud).toBeGreaterThan(.39); expect(changed.detector).toBe('independent');
  await page.locator('[data-action="history.undo"]').click();
  await expect.poll(() => page.evaluate(async () => (await websoundedit.execute('clip.getAudio')).channels[0][0])).toBeCloseTo(.001, 8);
  expect(errors).toEqual([]);
});
