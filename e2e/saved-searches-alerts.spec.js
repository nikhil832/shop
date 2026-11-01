import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Saved searches (stage 144). The demo sends no email, so this checks saving, listing and removing; the hourly
// check is covered by the API tests.
test('a customer saves a search and manages it on the account page', async ({ page }) => {
  // Guests are offered a way in.
  await page.goto('/search?q=voltix&category=mobiles');
  await expect(page.getByRole('link', { name: 'Email me new arrivals' })).toHaveAttribute(
    'href',
    '/login?next=%2Fsearch%3Fq%3Dvoltix%26category%3Dmobiles',
  );

  await page.request.post('/api/auth/register', {
    data: { name: 'Neha Jain', email: `searches-${Date.now().toString(36)}@example.com`, password: 'password123' },
  });
  await page.goto('/search?q=voltix&category=mobiles&sort=price_asc');
  await page.getByRole('button', { name: 'Tell me about new arrivals' }).click();
  await expect(page.getByRole('status')).toContainText("Saved. We'll email you when new products match.");
  expect((await new AxeBuilder({ page }).include('.save-search').analyze()).violations).toEqual([]);

  await page.getByRole('link', { name: 'Your saved searches' }).click();
  const section = page.getByRole('region', { name: 'Saved searches' });
  const saved = section.getByRole('link', { name: '“voltix” in Mobiles' });
  await expect(saved).toHaveAttribute('href', '/search?q=voltix&category=mobiles');
  await section.getByRole('button', { name: /^Remove/ }).click();
  await expect(section.getByRole('status')).toHaveText('Search removed.');
  await expect(saved).toHaveCount(0);
});
