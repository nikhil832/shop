import { test, expect } from '@playwright/test';

const row = (page, name) => page.getByRole('region', { name });

test('a product page shows similar products from its category', async ({ page }) => {
  await page.goto('/p/voltix-nova-5g-8gb-ram-128gb');
  const similar = row(page, 'Similar products');
  await expect(similar.getByRole('link').first()).toContainText('Voltix Nova Pro 5G');
  await expect(similar.getByRole('link', { name: /Voltix Nova 5G \(8GB/ })).toHaveCount(0);

  // Following one goes to that product, with its own similar products.
  await similar.getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Voltix Nova Pro 5G (12GB RAM, 256GB)');
  await expect(row(page, 'Similar products').getByRole('link').first()).toContainText('Voltix Nova 5G (8GB');
});

test('recently viewed products follow the visitor, newest first, until cleared', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Top rated' })).toBeVisible();
  await expect(row(page, 'Recently viewed')).toHaveCount(0);

  await page.goto('/p/the-quiet-engineer-paperback');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // The page doesn't list itself.
  await expect(row(page, 'Recently viewed')).toHaveCount(0);

  await page.goto('/p/voltix-nova-5g-8gb-ram-128gb');
  const recent = row(page, 'Recently viewed');
  await expect(recent.getByRole('link')).toHaveCount(1);
  await expect(recent.getByRole('link')).toContainText('The Quiet Engineer');

  await page.goto('/');
  const cards = row(page, 'Recently viewed').getByRole('link');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Voltix Nova 5G');
  await expect(cards.nth(1)).toContainText('The Quiet Engineer');
  await expect(cards.nth(1)).toContainText('₹349');

  await row(page, 'Recently viewed').getByRole('button', { name: 'Clear' }).click();
  await expect(row(page, 'Recently viewed')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Top rated' })).toBeVisible();
  await expect(row(page, 'Recently viewed')).toHaveCount(0);
});

test('frequently bought together appears once two customers bought products in one order', async ({
  page,
  browser,
}) => {
  const MIXER = '/p/rasoi-mixer-grinder-750w';
  const address = {
    name: 'Kabir Shah',
    phone: '9123456780',
    line1: '12 Hill Road',
    city: 'Pune',
    state: 'Maharashtra',
    pincode: '411001',
  };
  const productId = async (api, q) => (await (await api.get(`/api/products?q=${q}`)).json()).items[0].id;
  // A new customer orders the mixer grinder and the book together (Cash on Delivery).
  async function buyBoth() {
    const api = (await (await browser.newContext()).newPage()).request;
    const email = `together-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    await api.post('/api/auth/register', { data: { name: 'Kabir Shah', email, password: 'password123' } });
    const items = [
      { productId: await productId(api, 'rasoi%20mixer'), qty: 1 },
      { productId: await productId(api, 'quiet%20engineer'), qty: 1 },
    ];
    const quote = await (await api.get(`/api/cart?items=${items.map((i) => `${i.productId}:1`).join(',')}`)).json();
    const res = await api.post('/api/orders', { data: { items, address, expectedTotal: quote.total } });
    expect(res.status()).toBe(201);
  }

  await buyBoth();
  await page.goto(MIXER);
  await expect(row(page, 'Similar products')).toBeVisible();
  // One customer's order isn't enough to show.
  await expect(row(page, 'Frequently bought together')).toHaveCount(0);

  await buyBoth();
  await page.reload();
  const together = row(page, 'Frequently bought together');
  await expect(together.getByRole('link').first()).toContainText('The Quiet Engineer');
});
