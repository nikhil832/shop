import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Its own product (hidden again at the end), since every spec shares the server and its counts.
test('Share uses the share sheet where there is one, else a menu; finished shares are counted', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await admin.request.get('/api/categories')).json();
  const title = `Kitwell Lamp ${Date.now().toString(36)}`;
  const res = await admin.request.post('/api/admin/products', {
    data: { title, brand: 'Kitwell', categoryId: category.id, price: 79900, mrp: 99900, stock: 9 },
  });
  expect(res.status()).toBe(201);
  const product = await res.json();
  const shares = async () =>
    (await (await admin.request.get('/api/admin/product-performance?days=7&sort=shares')).json()).items.find(
      (r) => r.productId === product.id,
    )?.shares ?? 0;
  try {
    // A phone: the share sheet (a stand-in that remembers what it was given). Closing it shares nothing.
    const phone = await browser.newContext();
    await phone.addInitScript(() => {
      globalThis.sharedWith = [];
      globalThis.navigator.share = async (data) => {
        globalThis.sharedWith.push(data);
        if (globalThis.cancelNext) {
          globalThis.cancelNext = false;
          throw new globalThis.DOMException('Share canceled', 'AbortError');
        }
      };
    });
    const page = await phone.newPage();
    await page.goto(`/p/${product.slug}`);
    await page.evaluate(() => (globalThis.cancelNext = true));
    const button = page.getByRole('button', { name: `Share ${title}` });
    await button.click();
    await button.click();
    const given = await page.evaluate(() => globalThis.sharedWith);
    expect(given).toHaveLength(2);
    expect(given[1]).toEqual({
      title,
      text: `${title} on Bazaar`,
      url: new URL(`/p/${product.slug}`, page.url()).href,
    });
    await expect(button).not.toHaveAttribute('aria-expanded');
    await expect.poll(shares).toBe(1);
    await phone.close();

    // A computer without one: a menu with Copy link, WhatsApp and Email.
    const desk = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await desk.addInitScript(() => delete globalThis.Navigator.prototype.share);
    const page2 = await desk.newPage();
    await page2.goto(`/p/${product.slug}`);
    const share = page2.getByRole('button', { name: `Share ${title}` });
    await share.click();
    await expect(share).toHaveAttribute('aria-expanded', 'true');
    const whatsapp = page2.getByRole('link', { name: 'WhatsApp' });
    await expect(whatsapp).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=/);
    expect(decodeURIComponent((await whatsapp.getAttribute('href')).split('text=')[1])).toBe(
      `${title} on Bazaar ${new URL(`/p/${product.slug}`, page2.url()).href}`,
    );
    await expect(page2.getByRole('link', { name: 'Email' })).toHaveAttribute('href', /^mailto:\?subject=/);
    expect(
      (await new AxeBuilder({ page: page2 }).include('.share').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
    await page2.keyboard.press('Escape');
    await expect(share).toHaveAttribute('aria-expanded', 'false');
    await expect(share).toBeFocused();

    await share.click();
    await page2.getByRole('button', { name: 'Copy link' }).click();
    await expect(page2.getByText('Link copied')).toBeVisible();
    expect(await page2.evaluate(() => globalThis.navigator.clipboard.readText())).toBe(
      new URL(`/p/${product.slug}`, page2.url()).href,
    );
    await expect.poll(shares).toBe(2);
    await desk.close();
  } finally {
    await admin.request.patch(`/api/admin/products/${product.id}`, { data: { active: false } });
  }
});
