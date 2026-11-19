import { test, expect } from '@playwright/test';
import { HELP_CHAPTERS, HELP_IMAGES } from '../src/help-content.js';

// Commit and execute this gate with the reviewed PNGs and populated HELP_IMAGES.
// A missing or partial image set is a failure, not an unsupported capability skip.
test('the illustrated guide loads all 22 reviewed images across every chapter', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  expect(HELP_CHAPTERS).toHaveLength(14);
  expect(HELP_IMAGES).toHaveLength(22);
  expect(new Set(HELP_IMAGES.map(image => image.path)).size).toBe(22);
  expect([...new Set(HELP_IMAGES.map(image => image.chapter))].sort())
    .toEqual(HELP_CHAPTERS.map(chapter => chapter.id).sort());

  for (const image of HELP_IMAGES) {
    expect(image.path).toMatch(/^help\/guide-[a-z0-9-]+\.png$/);
    expect(Number.isInteger(image.width)).toBe(true);
    expect(Number.isInteger(image.height)).toBe(true);
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
    expect(typeof image.alt).toBe('string');
    expect(typeof image.caption).toBe('string');
    expect(image.alt.trim().split(/\s+/).length).toBeGreaterThanOrEqual(6);
    expect(image.caption.trim().split(/\s+/).length).toBeGreaterThanOrEqual(8);
    expect(image.alt).not.toMatch(/\b(?:TODO|TBD|placeholder|coming soon)\b/i);
    expect(image.caption).not.toMatch(/\b(?:TODO|TBD|placeholder|coming soon)\b/i);
    expect(image.alt).not.toContain(image.path.split('/').pop());
    expect(image.caption).not.toBe(image.alt);
  }

  await page.goto('/#help/navigation');
  await page.waitForFunction(() => Boolean(window.websoundedit?.ready));
  await page.evaluate(() => websoundedit.ready);
  await expect(page.locator('#workbench-view')).toBeVisible();

  const loaded = [];
  for (const chapter of HELP_CHAPTERS) {
    await test.step(chapter.title, async () => {
      const chapterLink = page.locator(`[data-help-chapter="${chapter.id}"]`);
      await chapterLink.click();
      await expect(page).toHaveURL(new RegExp(`#help/${chapter.id}$`));
      await expect(chapterLink).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('#help-article > h3')).toHaveText(chapter.title);

      const images = HELP_IMAGES.filter(image => image.chapter === chapter.id);
      const figures = page.locator('#help-article .help-figure');
      await expect(figures).toHaveCount(images.length);
      for (const [index, expected] of images.entries()) {
        const figure = figures.nth(index);
        const image = figure.getByRole('img', { name: expected.alt, exact: true });
        await expect(image).toHaveAttribute('width', String(expected.width));
        await expect(image).toHaveAttribute('height', String(expected.height));
        await expect(figure.locator('figcaption')).toHaveText(expected.caption);

        // Trigger native lazy loading through the actual scrolling Help view.
        await image.scrollIntoViewIfNeeded();
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate(node => ({
          complete: node.complete,
          width: node.naturalWidth,
          height: node.naturalHeight,
        })), { message: `Load the real Help PNG: ${expected.path}` }).toEqual({
          complete: true,
          width: expected.width,
          height: expected.height,
        });
        expect(await image.evaluate(node => node.currentSrc))
          .toBe(new URL(expected.path, page.url()).href);
        loaded.push(expected.path);
      }
    });
  }

  expect(loaded).toHaveLength(22);
  expect(new Set(loaded).size).toBe(22);
  expect(errors).toEqual([]);
});
