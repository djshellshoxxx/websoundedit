import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { encodeWav, decodeWav } from '../src/wav.js';

async function boot(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.websoundedit?.ready));
  await page.evaluate(() => window.websoundedit.ready);
  await expect(page.locator('.track-waveform')).toHaveCount(3);
  return errors;
}

async function stablePaint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('demo, waveform pointer selection, exact selection inputs, and keyboard command discovery', async ({ page }) => {
  const errors = await boot(page);
  await expect(page.locator('#status')).toContainText('Demo ready');
  const bounds = await page.locator('.track-waveform').first().boundingBox();
  await page.mouse.move(bounds.x + bounds.width * 0.12, bounds.y + 60);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.22, bounds.y + 60, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => websoundedit.getState().selection?.start)).toBeGreaterThan(0.8);
  await expect.poll(() => page.evaluate(() => websoundedit.getState().selection?.end)).toBeLessThan(1.9);
  await page.locator('#selection-start').fill('1');
  await page.locator('#selection-start').press('Tab');
  await expect.poll(() => page.evaluate(() => websoundedit.getState().selection.start)).toBe(1);
  await page.locator('#selection-end').fill('2.5');
  await page.locator('#selection-end').press('Tab');
  await expect.poll(() => page.evaluate(() => websoundedit.getState().selection.end)).toBe(2.5);
  await page.locator('#channel-scope').selectOption('left');
  await expect.poll(() => page.evaluate(() => websoundedit.getState().selection.channels)).toBe('left');
  await page.keyboard.press('Control+k');
  await expect(page.locator('#command-palette')).toBeVisible();
  await page.locator('#command-search').fill('reverse');
  await expect(page.locator('[data-command-id="effect.reverse"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#command-palette')).not.toBeVisible();
  const commands = await page.evaluate(() => websoundedit.commands());
  expect(commands.ui.every(command => typeof command.shortcut === 'string' && command.shortcut.length > 0)).toBe(true);
  expect(new Set(commands.ui.map(command => command.shortcut)).size).toBe(commands.ui.length);
  for (const effect of ['reverse', 'pitch', 'stretch', 'eq', 'duck', 'granular', 'beatRepeat']) {
    expect(commands.core.some(command => command.method === `effect.${effect}`)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('effect preview changes real waveform pixels without committing; apply, undo and redo preserve selection/channel boundaries', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(async () => {
    const api = websoundedit, clipId = api.getState().selectedClipId;
    await api.execute('selection.set', { clipId, start: 1, end: 3, channels: 'left' });
    window.__before = await api.execute('clip.getAudio', { clipId });
    window.__clipId = clipId;
  });
  await stablePaint(page);
  const beforePixels = await page.locator('.track-waveform').first().evaluate(canvas => {
    const bytes = canvas.getContext('2d').getImageData(0, 25, canvas.width, canvas.height - 25).data;
    let hash = 2166136261; for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
    return hash >>> 0;
  });
  await page.evaluate(() => websoundedit.previewEffect('gain', { db: -12 }));
  await expect(page.locator('#preview-state')).toContainText('preview ready');
  await stablePaint(page);
  const afterPixels = await page.locator('.track-waveform').first().evaluate(canvas => {
    const bytes = canvas.getContext('2d').getImageData(0, 25, canvas.width, canvas.height - 25).data;
    let hash = 2166136261; for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
    return hash >>> 0;
  });
  expect(afterPixels).not.toBe(beforePixels);
  const preview = await page.evaluate(async () => {
    const original = window.__before;
    const draft = await websoundedit.execute('effect.preview', { effect: 'gain', params: { db: -12 } });
    const committed = await websoundedit.execute('clip.getAudio', { clipId: window.__clipId });
    let unchanged = true, rightUnchanged = true, outsideUnchanged = true, maxError = 0;
    for (let i = 0; i < original.channels[0].length; i++) {
      unchanged &&= original.channels[0][i] === committed.channels[0][i];
      rightUnchanged &&= original.channels[1][i] === draft.channels[1][i];
      if (i < original.sampleRate || i >= 3 * original.sampleRate) outsideUnchanged &&= original.channels[0][i] === draft.channels[0][i];
      else maxError = Math.max(maxError, Math.abs(draft.channels[0][i] - original.channels[0][i] * 10 ** (-12 / 20)));
    }
    window.__draft = draft;
    return { unchanged, rightUnchanged, outsideUnchanged, maxError };
  });
  expect(preview.unchanged && preview.rightUnchanged && preview.outsideUnchanged).toBe(true);
  expect(preview.maxError).toBeLessThan(1e-7);
  await page.locator('#apply-effect').click();
  await expect(page.locator('#status')).toContainText('Gain applied');
  const matches = async which => page.evaluate(async key => {
    const current = await websoundedit.execute('clip.getAudio', { clipId: window.__clipId });
    return current.channels.every((channel, c) => channel.every((sample, i) => sample === window[key].channels[c][i]));
  }, which);
  expect(await matches('__draft')).toBe(true);
  await page.keyboard.press('Control+z');
  await expect.poll(() => matches('__before')).toBe(true);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => matches('__draft')).toBe(true);
  expect(errors).toEqual([]);
});

test('duration edits, clip splitting and portable JSON round-trip retain exact edited PCM', async ({ page }) => {
  const errors = await boot(page);
  const result = await page.evaluate(async () => {
    const api = websoundedit;
    await api.execute('project.new', { name: 'Duration and persistence', sampleRate: 48000 });
    const created = await api.execute('audio.generate', { type: 'tone', frequency: 440, duration: 2, amplitude: 0.4, channels: 2 });
    await api.execute('selection.set', { clipId: created.clipId, start: 0.5, end: 1.5, channels: 'all' });
    await api.execute('effect.stretch', { ratio: 1.5, preservePitch: true });
    const stretched = api.getState().tracks[0].clips[0].duration;
    await api.execute('selection.clear');
    await api.execute('clip.split', { clipId: created.clipId, at: 1 });
    const clips = api.getState().tracks[0].clips;
    await api.execute('markers.add', { time: 0.5, name: 'Reference' });
    const project = await api.saveProject({ download: false });
    const before = JSON.stringify(project.tracks.map(t => t.clips.map(c => c.audio)));
    await api.execute('effect.reverse');
    await api.loadProject(JSON.parse(JSON.stringify(project)));
    const restored = await api.saveProject({ download: false });
    return { stretched, clips: clips.map(c => ({ start: c.start, duration: c.duration })),
      samePCM: before === JSON.stringify(restored.tracks.map(t => t.clips.map(c => c.audio))),
      marker: restored.markers[0]?.name, name: restored.name };
  });
  expect(result.stretched).toBeCloseTo(2.5, 4);
  expect(result.clips).toEqual([{ start: 0, duration: 1 }, { start: 1, duration: 1.5 }]);
  expect(result.samePCM).toBe(true);
  expect(result.marker).toBe('Reference');
  expect(result.name).toBe('Duration and persistence');
  expect(errors).toEqual([]);
});

test('drawn gate and actual track-sidechain processing work through the visible effect inspector', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(async () => {
    const state = websoundedit.getState(), target = state.tracks[1].clips[0];
    await websoundedit.execute('selection.set', { clipId: target.id, start: 1, end: 3, channels: 'all' });
    window.__targetId = target.id;
    window.__sidechainBefore = await websoundedit.execute('clip.getAudio', { clipId: target.id });
  });
  await page.locator('[data-panel="rhythm"]').click();
  await page.locator('[data-duck-preset="gate"]').click();
  await expect(page.locator('#preview-state')).toContainText('preview ready');
  // Click well above a point at the same x, then drag toward its neighbor.
  // The editor must reuse the existing point and keep positions strictly ordered.
  await page.locator('#duck-visual').scrollIntoViewIfNeeded();
  const curve = await page.locator('#duck-visual').boundingBox();
  const plot = { x: curve.x + 26, y: curve.y + 17, width: curve.width - 38, height: curve.height - 39 };
  await page.mouse.move(plot.x + plot.width * 0.47, plot.y + plot.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(plot.x + plot.width * 0.48, plot.y + plot.height * 0.35, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#preview-state')).toContainText('preview ready');
  const dragged = await page.evaluate(() => websoundedit.saveSettings().effects.duck.points);
  expect(dragged).toHaveLength(6);
  expect(dragged.every((point, index) => !index || point.x > dragged[index - 1].x)).toBe(true);
  expect(dragged[1].y).toBeGreaterThan(0.4);
  await page.locator('[data-duck-preset="gate"]').click();
  await page.getByText('Keyboard envelope points', { exact: true }).click();
  const originalPoints = await page.evaluate(() => websoundedit.saveSettings().effects.duck.points);
  await page.getByRole('button', { name: 'Add envelope point', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-duck-position]')).toHaveCount(7);
  const addedPoints = await page.evaluate(() => websoundedit.saveSettings().effects.duck.points);
  const addedIndex = addedPoints.findIndex(point => !originalPoints.some(original => original.x === point.x));
  expect(addedIndex).toBeGreaterThan(0);
  const adjustedPosition = (addedPoints[addedIndex - 1].x + addedPoints[addedIndex].x) / 2;
  await page.getByLabel(`Envelope point ${addedIndex + 1} position`, { exact: true }).fill(String(adjustedPosition));
  expect(await page.evaluate(index => websoundedit.saveSettings().effects.duck.points[index].x, addedIndex)).toBe(adjustedPosition);
  await page.getByRole('button', { name: `Remove envelope point ${addedIndex + 1}`, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-duck-position]')).toHaveCount(6);
  expect(await page.evaluate(() => websoundedit.saveSettings().effects.duck.points)).toEqual(originalPoints);
  await page.getByLabel('Envelope point 3 gain', { exact: true }).fill('0.6');
  await expect(page.locator('#preview-state')).toContainText('preview ready');
  const gate = await page.evaluate(() => websoundedit.saveSettings().effects.duck);
  expect(gate.depth).toBe(1);
  expect(gate.points[2].y).toBe(0.6);
  await page.locator('#apply-effect').click();
  await expect(page.locator('#status')).toContainText('applied');
  const gateResult = await page.evaluate(async () => {
    const before = window.__sidechainBefore, after = await websoundedit.execute('clip.getAudio', { clipId: window.__targetId });
    let beforeEnergy = 0, afterEnergy = 0, outsideSame = true;
    for (let i = 0; i < before.channels[0].length; i++) {
      if (i >= before.sampleRate && i < 3 * before.sampleRate) { beforeEnergy += before.channels[0][i] ** 2; afterEnergy += after.channels[0][i] ** 2; }
      else outsideSame &&= before.channels[0][i] === after.channels[0][i];
    }
    return { beforeEnergy, afterEnergy, outsideSame };
  });
  expect(gateResult.afterEnergy).toBeLessThan(gateResult.beforeEnergy * 0.85);
  expect(gateResult.outsideSame).toBe(true);
  await page.evaluate(() => websoundedit.execute('history.undo'));
  await page.getByLabel('Sidechain source', { exact: true }).selectOption('track');
  await page.getByLabel('Ducking mode', { exact: true }).selectOption('compressor');
  const triggerId = await page.evaluate(() => websoundedit.getState().tracks[0].id);
  await page.getByLabel('Sidechain audio track', { exact: true }).selectOption(triggerId);
  await expect(page.locator('#preview-state')).toContainText('preview ready');
  await page.locator('#apply-effect').click();
  await expect(page.locator('#status')).toContainText('applied');
  const decreased = await page.evaluate(async () => {
    const after = await websoundedit.execute('clip.getAudio', { clipId: window.__targetId });
    let a = 0, b = 0; for (let i = 48000; i < 144000; i++) { a += after.channels[0][i] ** 2; b += window.__sidechainBefore.channels[0][i] ** 2; }
    return a < b;
  });
  expect(decreased).toBe(true);
  expect(errors).toEqual([]);
});

test('loop studio and selection transport audition only the intended region', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(() => websoundedit.execute('selection.set', { start: 1, end: 1.25, channels: 'all' }));
  await page.locator('#loop-button').click();
  await page.locator('#metronome-button').click();
  await page.locator('[data-action="transport.selection"]').click();
  await expect(page.locator('#play-button')).toHaveClass(/playing/);
  await expect.poll(async () => {
    const value = await page.locator('#playhead-time').textContent();
    return Number(value.split(':')[1]);
  }).toBeGreaterThanOrEqual(1);
  const times = [];
  for (let i = 0; i < 6; i++) {
    times.push(await page.locator('#playhead-time').textContent());
    await page.waitForTimeout(80); // Exercise several audio-clock updates and a loop boundary.
  }
  expect(times.every(value => Number(value.split(':')[1]) >= 1 && Number(value.split(':')[1]) <= 1.251)).toBe(true);
  await page.locator('[data-action="transport.stop"]').click();
  await expect(page.locator('#play-button')).not.toHaveClass(/playing/);
  await expect(page.locator('#playhead-time')).toHaveText('00:00.000');
  await page.locator('[data-action="panel.loop"]').click();
  await page.locator('#loop-repeats').fill('4');
  await page.locator('#loop-crossfade').fill('0');
  await page.locator('#loop-create').click();
  await expect(page.locator('.track-waveform')).toHaveCount(4);
  expect(await page.evaluate(() => websoundedit.getState().tracks.at(-1).clips[0].duration)).toBe(1);
  expect(errors).toEqual([]);
});

test('actual file input and selection download preserve selected duration and channel', async ({ page }) => {
  const errors = await boot(page);
  const sampleRate = 32000;
  const left = Float32Array.from({ length: sampleRate }, (_, i) => 0.4 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
  const right = Float32Array.from({ length: sampleRate }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 880 * i / sampleRate));
  await page.locator('#audio-input').setInputFiles({ name: 'selected-fixture.wav', mimeType: 'audio/wav', buffer: Buffer.from(encodeWav({ sampleRate, channels: [left, right] }, { bitDepth: 32, float: true })) });
  await expect(page.locator('#status')).toContainText('Imported selected-fixture.wav');
  await page.evaluate(() => websoundedit.execute('selection.set', { start: 0.125, end: 0.375, channels: 'right' }));
  await page.locator('[data-action="selection.export"]').click();
  await page.locator('#export-format').selectOption('wav');
  await page.locator('#export-depth').selectOption('32');
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-go').click();
  const downloaded = await downloadEvent;
  const decoded = decodeWav(await readFile(await downloaded.path()));
  expect(downloaded.suggestedFilename()).toMatch(/-selection\.wav$/);
  expect(decoded.sampleRate).toBe(48000);
  expect(decoded.channels).toHaveLength(1);
  expect(decoded.channels[0]).toHaveLength(12000);
  expect(Math.max(...decoded.channels[0])).toBeGreaterThan(0.19);
  expect(Math.max(...decoded.channels[0])).toBeLessThan(0.21);
  expect(errors).toEqual([]);
});

test('responsive workbench retains controls without page overflow and produces review screenshots', async ({ page }, testInfo) => {
  const errors = await boot(page);
  for (const [name, width, height] of [['desktop', 1440, 1000], ['tablet', 768, 1024], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await stablePaint(page);
    await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`), fullPage: true });
    const geometry = await page.evaluate(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth }));
    expect.soft(geometry.scroll, `${name}: no horizontal page overflow`).toBeLessThanOrEqual(geometry.inner + 1);
    await expect(page.locator('#play-button')).toBeVisible();
    await expect(page.locator('#apply-effect')).toBeVisible();
    const commands = page.getByRole('button', { name: 'Find a command', exact: true });
    await expect(commands).toBeVisible();
    const commandBox = await commands.boundingBox();
    expect.soft(commandBox.x, `${name}: command entry is not clipped on the left`).toBeGreaterThanOrEqual(0);
    expect.soft(commandBox.x + commandBox.width, `${name}: command entry fits horizontally`).toBeLessThanOrEqual(width + 1);
    for (const action of ['analysis.bpm', 'tempo.tap', 'tempo.half', 'tempo.double']) {
      const control = page.locator(`.tempo-actions [data-action="${action}"]`);
      await expect(control, `${name}: ${action} stays visible`).toBeVisible();
      const box = await control.boundingBox();
      expect.soft(box.x, `${name}: ${action} starts inside viewport`).toBeGreaterThanOrEqual(0);
      expect.soft(box.x + box.width, `${name}: ${action} ends inside viewport`).toBeLessThanOrEqual(width + 1);
    }
  }
  expect(errors).toEqual([]);
});

test('mix transport plays existing audio while an empty track is selected', async ({ page }) => {
  const errors = await boot(page);
  await page.locator('[data-action="track.add"]').click();
  await expect(page.locator('.track-waveform')).toHaveCount(4);
  const selected = await page.evaluate(() => {
    const state = websoundedit.getState();
    return { clips: state.tracks.find(track => track.id === state.selectedTrackId).clips.length, duration: state.duration };
  });
  expect(selected.clips).toBe(0);
  expect(selected.duration).toBeGreaterThan(0);
  await page.locator('#play-button').click();
  await expect(page.locator('#play-button')).toHaveClass(/playing/);
  await expect(page.locator('#status')).toContainText('Playing the mix');
  await expect.poll(async () => Number((await page.locator('#playhead-time').textContent()).split(':')[1])).toBeGreaterThan(0.03);
  await page.locator('[data-action="transport.stop"]').click();
  await expect(page.locator('#play-button')).not.toHaveClass(/playing/);
  expect(errors).toEqual([]);
});

test('loading settings clears old and pending previews, and Apply uses the restored parameters', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(async () => {
    window.__settingsBeforeAudio = await websoundedit.execute('clip.getAudio');
    websoundedit.previewEffect('gain', { db: -12 });
  });
  await expect(page.locator('#preview-state')).toContainText('preview ready');
  await page.evaluate(() => {
    const settings = websoundedit.saveSettings();
    settings.selectedEffect = 'gain';
    settings.effects.gain.db = -6;
    websoundedit.loadSettings(settings);
  });
  await expect(page.locator('#effect-select')).toHaveValue('gain');
  await expect(page.locator('#effect-db')).toHaveValue('-6');
  await expect(page.locator('#render-indicator')).toHaveText('LIVE PCM VIEW');
  await expect(page.locator('#preview-state')).not.toContainText('preview ready');
  await page.evaluate(() => {
    const settings = websoundedit.saveSettings();
    websoundedit.previewEffect('gain', { db: -18 });
    websoundedit.loadSettings(settings);
  });
  // The old preview timer is 220 ms. Waiting past it verifies that loading
  // settings invalidates pending work instead of repainting an obsolete draft.
  await page.waitForTimeout(350);
  await expect(page.locator('#render-indicator')).toHaveText('LIVE PCM VIEW');
  await expect(page.locator('#effect-db')).toHaveValue('-6');
  await page.locator('#apply-effect').click();
  await expect(page.locator('#status')).toContainText('Gain applied');
  const result = await page.evaluate(async () => {
    const api = websoundedit, before = window.__settingsBeforeAudio, after = await api.execute('clip.getAudio');
    const selection = api.getState().selection;
    let error = 0, outsideSame = true;
    for (let i = 0; i < before.channels[0].length; i++) {
      if (i >= selection.start * before.sampleRate && i < selection.end * before.sampleRate) error = Math.max(error, Math.abs(after.channels[0][i] - before.channels[0][i] * 10 ** (-6 / 20)));
      else outsideSame &&= after.channels[0][i] === before.channels[0][i];
    }
    const project = await api.saveProject({ download: false });
    const alternate = api.saveSettings(); alternate.selectedEffect = 'pitch'; alternate.effects.pitch.semitones = 7;
    api.loadSettings(alternate);
    await api.loadProject(project);
    return { error, outsideSame, selectedEffect: api.saveSettings().selectedEffect, gain: api.saveSettings().effects.gain.db };
  });
  expect(result.error).toBeLessThan(1e-7);
  expect(result.outsideSame).toBe(true);
  expect(result.selectedEffect).toBe('gain');
  expect(result.gain).toBe(-6);
  await expect(page.locator('#effect-db')).toHaveValue('-6');
  await expect(page.locator('#render-indicator')).toHaveText('LIVE PCM VIEW');
  expect(errors).toEqual([]);
});

test('invalid imported settings reject before changing preferences or inserting markup', async ({ page }) => {
  const errors = await boot(page);
  const rejected = await page.evaluate(() => {
    const original = websoundedit.saveSettings();
    const variants = [
      { effects: { gain: { db: '<img src=x onerror="window.__settingsExecuted=1">' } } },
      { effects: { pitch: { semitones: 99 } } },
      { effects: { duck: { points: [{ x: 0, y: 0 }, { x: 0, y: 1 }] } } },
      { effects: { eq: { bands: [] } } },
      { effects: { beatRepeat: { pattern: [0, 1.5] } } },
      { shortcuts: { 'transport.play': 'ctrl+z' } },
    ];
    return variants.map(patch => {
      const value = { ...structuredClone(original), ...patch };
      try { websoundedit.loadSettings(value); return { rejected: false, unchanged: false }; }
      catch (error) { return { rejected: true, message: error.message, unchanged: JSON.stringify(websoundedit.saveSettings()) === JSON.stringify(original) }; }
    });
  });
  expect(rejected.every(result => result.rejected && result.unchanged && result.message)).toBe(true);
  const invalidFile = {
    format: 'websoundedit-ui-settings', version: 1, selectedEffect: 'gain',
    effects: { gain: { db: '<img src=x onerror="window.__settingsExecuted=1">' } },
  };
  await page.locator('#settings-input').setInputFiles({ name: 'invalid-settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalidFile)) });
  await expect(page.locator('#status')).toContainText('Invalid gain.db setting');
  expect(await page.evaluate(() => window.__settingsExecuted === 1)).toBe(false);
  await expect(page.locator('#effect-controls img')).toHaveCount(0);
  await expect(page.locator('.track-waveform')).toHaveCount(3);
  expect(errors).toEqual([]);
});
