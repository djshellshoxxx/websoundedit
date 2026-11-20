import { test, expect } from '@playwright/test';

test('Loop arms the selected range before first play without opening audio output', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.websoundedit?.ready));
  await page.evaluate(() => websoundedit.ready);
  const expected = await page.evaluate(() => {
    const state = websoundedit.getState();
    const clip = state.tracks.flatMap(track => track.clips).find(item => item.id === state.selectedClipId);
    return [clip.start + state.selection.start, clip.start + state.selection.end];
  });
  await page.locator('#loop-button').click();
  await expect(page.locator('#status')).toContainText('Loop playback enabled');
  await expect(page.locator('#loop-button')).toHaveAttribute('aria-pressed', 'true');
  const live = await page.evaluate(() => websoundedit.live.getState());
  expect([live.transport.loopStart, live.transport.loopEnd]).toEqual(expected);
  expect(live.transport.loop).toBe(true);
  expect(live.context.state).toBe('not-started');
  await page.locator('#loop-button').click();
  await expect(page.locator('#status')).toContainText('Loop playback disabled');
  expect(await page.evaluate(() => websoundedit.live.getState().transport.loop)).toBe(false);
  expect(errors).toEqual([]);
});
