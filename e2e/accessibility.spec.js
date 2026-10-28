import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Every page checked by axe against WCAG 2.1 A and AA (contrast, labels, names, structure): all of them in the light
// theme, and those with the most colours in the dark one. A failure names the rule, the page and the elements.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function expectAccessible(page, path) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Loading…')).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const report = violations.map(
    (v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
  );
  expect(report, `${path}\n  ${report.join('\n  ')}`).toEqual([]);
}

// A customer with a saved product, a cart and an order; an admin; and the ids their pages need.
async function setUp(browser, colorScheme) {
  const customer = await (await browser.newContext({ colorScheme })).newPage();
  const email = `a11y-${colorScheme}-${Date.now()}@example.com`;
  await customer.request.post('/api/auth/register', { data: { name: 'Anu Varma', email, password: 'password123' } });
  const book = await (await customer.request.get('/api/products/the-quiet-engineer-paperback')).json();
  await customer.request.put(`/api/wishlist/${book.id}`);
  const quote = await (await customer.request.get(`/api/cart?items=${book.id}:1`)).json();
  const order = await (
    await customer.request.post('/api/orders', {
      data: {
        items: [{ productId: book.id, qty: 1 }],
        address: {
          name: 'Anu Varma',
          phone: '9123456780',
          line1: '1 Lake Road',
          city: 'Pune',
          state: 'Maharashtra',
          pincode: '411001',
        },
        expectedTotal: quote.total,
      },
    })
  ).json();
  await customer.goto('/p/the-quiet-engineer-paperback');
  await customer.getByRole('button', { name: 'Add to cart' }).click();

  const admin = await (await browser.newContext({ colorScheme })).newPage();
  await admin.request.post('/api/auth/login', { data: ADMIN });
  const product = (await (await admin.request.get('/api/admin/products?q=kurta')).json()).items[0];
  return { customer, admin, order, product };
}

const SHOP = [
  '/',
  '/search?q=phone',
  '/search?q=kettel',
  '/p/the-quiet-engineer-paperback',
  '/p/urbane-men-slim-fit-jeans',
];
const SIGNED_OUT = ['/login', '/register', '/forgot-password', '/no-such-page', '/help'];
const CUSTOMER = (o) => [
  '/cart',
  '/checkout',
  '/orders',
  `/orders/${o.id}`,
  `/orders/${o.id}/invoice`,
  '/wishlist',
  '/gift-cards',
  '/compare?slugs=stride-running-shoes,urbane-men-slim-fit-jeans',
  '/account',
  '/help',
];
const ADMIN_PAGES = (o, p) => [
  '/admin',
  '/admin/orders',
  `/admin/orders/${o.id}`,
  `/admin/orders/${o.id}/invoice`,
  `/admin/orders/slips?ids=${o.id}`,
  '/admin/products',
  '/admin/products/new',
  `/admin/products/${p.id}`,
  `/admin/products/${p.id}/stock`,
  '/admin/products/import',
  '/admin/categories',
  '/admin/reviews',
  '/admin/questions',
  '/admin/returns',
  '/admin/coupons',
  '/admin/delivery',
  '/admin/gst',
  '/admin/activity',
  '/admin/errors',
  '/admin/help',
  '/admin/staff',
  '/admin/sales',
  '/admin/announcements',
  '/admin/customers',
  '/admin/searches',
  '/admin/gift-cards',
];

test('every page passes the accessibility check (light theme)', async ({ browser }) => {
  test.setTimeout(120_000);
  const visitor = await (await browser.newContext()).newPage();
  for (const path of [...SHOP, ...SIGNED_OUT]) await expectAccessible(visitor, path);
  const { customer, admin, order, product } = await setUp(browser, 'light');
  for (const path of [...CUSTOMER(order), ...SHOP]) await expectAccessible(customer, path);
  for (const path of ADMIN_PAGES(order, product)) await expectAccessible(admin, path);
});

test('the most colourful pages pass in the dark theme too', async ({ browser }) => {
  test.setTimeout(120_000);
  const { customer, admin, order } = await setUp(browser, 'dark');
  for (const path of [
    '/',
    '/p/urbane-men-slim-fit-jeans',
    '/cart',
    '/checkout',
    `/orders/${order.id}/invoice`,
    '/account',
  ]) {
    await expectAccessible(customer, path);
  }
  for (const path of ['/admin', '/admin/orders', `/admin/orders/${order.id}`, '/admin/products/new', '/admin/gst']) {
    await expectAccessible(admin, path);
  }
});
