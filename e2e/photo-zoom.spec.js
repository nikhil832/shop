import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('the product photo opens full screen: next and previous, arrow keys, zoom, Escape', async ({ page }) => {
  await page.goto('/p/the-quiet-engineer-paperback');
  const main = page.locator('.gallery-main img');
  await page.getByRole('button', { name: 'Enlarge photo 1 of 3' }).click();
  const viewer = page.getByRole('dialog', { name: 'Photos of The Quiet Engineer (Paperback)' });
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText('Photo 1 of 3');
  expect(
    (await new AxeBuilder({ page }).include('.photo-viewer').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);

  await viewer.getByRole('button', { name: 'Next photo' }).click();
  await expect(viewer).toContainText('Photo 2 of 3');
  await page.keyboard.press('ArrowRight');
  await expect(viewer).toContainText('Photo 3 of 3');
  await page.keyboard.press('ArrowRight'); // round to the first
  await expect(viewer).toContainText('Photo 1 of 3');
  await page.keyboard.press('ArrowLeft');
  await expect(viewer).toContainText('Photo 3 of 3');

  const zoom = viewer.getByRole('button', { name: 'Zoom in' });
  await zoom.click();
  await expect(viewer.getByRole('button', { name: 'Zoom out' })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('img')).toHaveClass(/zoomed/);

  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  // The page shows the photo the viewer was on.
  await expect(page.getByRole('button', { name: 'Show image 3' })).toHaveAttribute('aria-pressed', 'true');
  await expect(main).toBeVisible();
});

test('on a phone, swiping the photo sideways moves between photos; a tap opens the viewer', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/p/the-quiet-engineer-paperback');
  const box = await page.locator('.gallery-main').boundingBox();
  const y = box.y + box.height / 2;
  // A swipe to the left: the next photo.
  await page.mouse.move(box.x + box.width * 0.8, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Show image 2' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('dialog')).toBeHidden(); // a swipe isn't a tap
  // A tap opens it on that photo.
  await page.locator('.gallery-main img').tap();
  await expect(page.getByRole('dialog', { name: /^Photos of/ })).toContainText('Photo 2 of 3');
  await context.close();
});
