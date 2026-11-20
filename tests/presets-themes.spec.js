import { test, expect } from '@playwright/test';
import { THEME_INFO } from '../src/themes.js';

async function boot(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.websoundedit?.ready));
  await page.evaluate(() => websoundedit.ready);
  return errors;
}

test('all ten themes preserve audio and expose readable palettes, a mobile gallery and portable settings', async ({ page }, testInfo) => {
  const errors = await boot(page);
  const before = await page.evaluate(async () => {
    const audio = await websoundedit.execute('clip.getAudio');
    return { channels: audio.channels.map(channel => Array.from(channel.slice(0, 512))), revision: websoundedit.getState().revision };
  });
  for (const [id, theme] of Object.entries(THEME_INFO)) {
    await page.locator('#theme-select').selectOption(id);
    await expect(page.locator('html')).toHaveAttribute('data-theme', id);
    await expect(page.locator('html')).toHaveAttribute('data-theme-tone', theme.tone);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', theme.background);
    const contrast = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const rgb = color => {
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
        context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(value => {
          const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
        });
      };
      const luminance = color => rgb(color).reduce((value, channel, index) => value + channel * [.2126, .7152, .0722][index], 0);
      const ratio = (first, second) => { const a = luminance(first), b = luminance(second); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
      const controls = [...document.querySelectorAll('.selection-title strong, .selection-bar label, .control-ticks, .timeline-scroll, .timeline-label small')].map(node => {
        let parent = node, background;
        // Resolve the actual opaque surface so fixed Studio colors cannot hide
        // behind passing palette-variable contrast checks.
        while (parent) {
          background = getComputedStyle(parent).backgroundColor;
          if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') break;
          parent = parent.parentElement;
        }
        return { label: node.textContent.trim().slice(0, 40), contrast: ratio(getComputedStyle(node).color, background) };
      });
      return { text: ratio(css.getPropertyValue('--text').trim(), css.getPropertyValue('--panel').trim()), muted: ratio(css.getPropertyValue('--muted').trim(), css.getPropertyValue('--panel').trim()), controls };
    });
    expect(contrast.text, `${id} text contrast`).toBeGreaterThanOrEqual(4.5);
    expect(contrast.muted, `${id} secondary text contrast`).toBeGreaterThanOrEqual(4.5);
    for (const control of contrast.controls) expect(control.contrast, `${id} ${control.label} contrast`).toBeGreaterThanOrEqual(4.5);
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator('[data-action="options"]').click();
  await expect(page.getByRole('group', { name: 'Theme gallery' }).locator('button')).toHaveCount(10);
  await page.locator('[data-theme-choice="paper"]').click();
  await expect(page.locator('#options-theme')).toHaveValue('paper');
  await expect(page.locator('[data-theme-choice="paper"]')).toHaveAttribute('aria-pressed', 'true');
  const geometry = await page.getByRole('group', { name: 'Theme gallery' }).evaluate(node => ({ width: node.scrollWidth, client: node.clientWidth, right: node.getBoundingClientRect().right }));
  expect(geometry.width).toBeLessThanOrEqual(geometry.client + 1); expect(geometry.right).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('paper-mobile-theme-gallery.png'), fullPage: true });
  const after = await page.evaluate(async () => {
    const saved = websoundedit.saveSettings();
    await websoundedit.execute('ui.theme.set', { theme: 'ocean' });
    await websoundedit.loadSettings(saved);
    const audio = await websoundedit.execute('clip.getAudio');
    return { theme: websoundedit.saveSettings().theme, channels: audio.channels.map(channel => Array.from(channel.slice(0, 512))), revision: websoundedit.getState().revision };
  });
  expect(after.theme).toBe('paper'); expect(after.channels).toEqual(before.channels); expect(after.revision).toBe(before.revision);
  expect(errors).toEqual([]);
});

test('preset browser previews without editing, limits selected samples and restores them with one Undo', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(async () => {
    await websoundedit.execute('project.new', { name: 'Preset selection', sampleRate: 8000 });
    const channel = Float32Array.from({ length: 1600 }, (_, i) => 1.35 * Math.sin(2 * Math.PI * 250 * i / 8000));
    await websoundedit.execute('clip.add', { name: 'Hot signal', audio: { sampleRate: 8000, channels: [channel] } });
    window.__presetOriginal = Array.from(channel);
    await websoundedit.execute('selection.set', { start: .05, end: .15, channels: 'all' });
  });
  await page.locator('[data-action="panel.presets"]').click();
  await page.locator('#preset-search').fill('auto limiter');
  await page.locator('[data-preset-id="auto-limiter"]').click();
  await expect(page.locator('#preset-detail')).toContainText(/limit/i);
  await expect(page.locator('#preview-state')).toContainText('preview ready');
  expect(await page.evaluate(async () => Array.from((await websoundedit.execute('clip.getAudio')).channels[0]).every((sample, i) => sample === window.__presetOriginal[i]))).toBe(true);
  await page.locator('#compare-button').click();
  await expect(page.locator('#compare-button')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#apply-effect').click();
  await expect(page.locator('#status')).toContainText('applied');
  const processed = await page.evaluate(async () => {
    const channel = (await websoundedit.execute('clip.getAudio')).channels[0];
    return { frames: channel.length, peak: Math.max(...channel.slice(400, 1200).map(Math.abs)), untouched: channel.every((sample, i) => i >= 400 && i < 1200 || sample === window.__presetOriginal[i]), preset: websoundedit.saveSettings().selectedPreset };
  });
  expect(processed.frames).toBe(1600); expect(processed.peak).toBeLessThanOrEqual(1); expect(processed.untouched).toBe(true); expect(processed.preset).toBe('auto-limiter');
  await page.locator('[data-action="history.undo"]').click();
  await expect.poll(() => page.evaluate(async () => Array.from((await websoundedit.execute('clip.getAudio')).channels[0]).every((sample, i) => sample === window.__presetOriginal[i]))).toBe(true);
  const saved = await page.evaluate(() => websoundedit.saveSettings());
  expect(saved.activePanel).toBe('presets');
  await page.locator('[data-panel="shape"]').click();
  await page.evaluate(settings => websoundedit.loadSettings(settings), saved);
  await expect(page.locator('#preset-controls')).toBeVisible();
  await expect(page.locator('[data-preset-id="auto-limiter"]')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('stereo vocal presets explain their scope and reject incompatible input without changing audio on a phone', async ({ page }, testInfo) => {
  const errors = await boot(page);
  await page.evaluate(async () => {
    await websoundedit.execute('project.new', { name: 'Mono source', sampleRate: 8000 });
    await websoundedit.execute('clip.add', { audio: { sampleRate: 8000, channels: [new Float32Array(800).fill(.2)] } });
    const state = websoundedit.getState();
    window.__presetBefore = JSON.stringify({ tracks: state.tracks, selection: state.selection, audio: await websoundedit.execute('clip.getAudio') });
  });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator('[data-action="panel.presets"]').click();
  await page.locator('#preset-search').fill('vocal');
  await page.locator('[data-preset-id="vocal-center"]').click();
  await expect(page.locator('#preset-source-note')).toContainText('stereo clip');
  await expect(page.locator('#preset-detail')).toContainText(/center/i);
  await expect(page.locator('#preview-state')).toContainText(/stereo/i);
  await page.locator('#apply-effect').click();
  await expect(page.locator('#status')).toContainText(/stereo/i);
  expect(await page.evaluate(async () => { const state = websoundedit.getState(); return JSON.stringify({ tracks: state.tracks, selection: state.selection, audio: await websoundedit.execute('clip.getAudio') }) === window.__presetBefore; })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const geometry = await page.locator('#preset-controls').evaluate(node => ({ width: node.scrollWidth, client: node.clientWidth }));
  expect(geometry.width).toBeLessThanOrEqual(geometry.client + 1);
  await page.screenshot({ path: testInfo.outputPath('mobile-vocal-preset.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('audio interface controls rescan device names and report hardware state without starting capture', async ({ page }) => {
  await page.addInitScript(() => {
    window.__deviceScans = 0;
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => {
      window.__deviceScans++;
      return [{ kind: 'audioinput', deviceId: 'usb-input', groupId: 'usb-interface', label: 'USB interface input' }, { kind: 'audiooutput', deviceId: 'usb-output', groupId: 'usb-interface', label: 'USB interface output' }];
    } });
  });
  const errors = await boot(page);
  await page.locator('[data-action="panel.audioDevices"]').click();
  await expect(page.locator('#input-device option[value="usb-input"]')).toHaveText('USB interface input');
  await expect(page.locator('#hardware-state')).toContainText('not-started');
  await expect(page.locator('#hardware-state')).toContainText('not a measured round trip');
  const before = await page.evaluate(() => window.__deviceScans);
  await page.locator('#audio-refresh-devices').click();
  await expect.poll(() => page.evaluate(() => window.__deviceScans)).toBeGreaterThan(before);
  const live = await page.evaluate(() => websoundedit.live.getState());
  expect(live.context.state).toBe('not-started'); expect(live.input.active).toBe(false); expect(live.output.maxChannels).toBe(null);
  expect(errors).toEqual([]);
});
