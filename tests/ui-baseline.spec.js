import { test, expect } from '@playwright/test';

async function boot(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.websoundedit?.ready));
  await page.evaluate(() => websoundedit.ready);
  return errors;
}

test('malformed saved shortcut preferences recover to working defaults', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('websoundedit.settings.v1', JSON.stringify({
    version: 1, shortcuts: { 'transport.play': { malformed: true } },
  })));
  const errors = await boot(page);
  await page.locator('#timeline').focus();
  await page.keyboard.press('q');
  await page.keyboard.press('Control+k');
  await expect(page.locator('#command-palette')).toBeVisible();
  expect(await page.evaluate(() => typeof websoundedit.saveSettings().shortcuts['transport.play'] !== 'object')).toBe(true);
  expect(errors).toEqual([]);
});

test('project names, metadata and dynamic track labels remain text rather than markup', async ({ page }) => {
  const errors = await boot(page);
  const hostile = '"><img data-audit-injected src=x onerror="window.__auditXss=1">';
  await page.evaluate(async name => {
    await websoundedit.execute('project.new', { name, sampleRate: 8000 });
    await websoundedit.execute('clip.add', { name, audio: { sampleRate: 8000, channels: [new Float32Array(800)] } });
    await websoundedit.execute('track.update', { name });
    await websoundedit.execute('metadata.update', { metadata: { title: name, artist: name } });
  }, hostile);
  await expect(page.locator('[data-track-select]')).toHaveText(hostile);
  await page.locator('[data-action="panel.metadata"]').click();
  await expect(page.getByLabel('Metadata Title', { exact: true })).toHaveValue(hostile);
  await page.locator('#modal-close').click();
  await page.locator('[data-action="panel.keys"]').click();
  await expect(page.locator('#modal-content')).toContainText(hostile);
  expect(await page.locator('[data-audit-injected]').count()).toBe(0);
  expect(await page.evaluate(() => window.__auditXss)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('Tools restore or clearly reject an invalid typed value before Apply', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(() => websoundedit.previewEffect('gain', { db: -6 }));
  await expect(page.locator('#preview-state')).toContainText('preview ready');
  const gain = page.locator('#effect-controls input[type="number"][data-key="db"]');
  await gain.fill('999');
  await gain.press('Tab');
  const displayed = await gain.inputValue();
  const blocked = await page.locator('#apply-effect').isDisabled();
  expect(displayed === '-6' || blocked).toBe(true);
  expect(errors).toEqual([]);
});
