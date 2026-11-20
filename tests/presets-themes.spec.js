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
      return { text: ratio(css.getPropertyValue('--text').trim(), css.getPropertyValue('--panel').trim()), muted: ratio(css.getPropertyValue('--muted').trim(), css.getPropertyValue('--panel').trim()) };
    });
    expect(contrast.text, `${id} text contrast`).toBeGreaterThanOrEqual(4.5);
    expect(contrast.muted, `${id} secondary text contrast`).toBeGreaterThanOrEqual(4.5);
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
