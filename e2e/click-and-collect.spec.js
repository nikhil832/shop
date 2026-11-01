import { test, expect } from '@playwright/test';

// Click and collect (stage 146). The pickup point is switched off again at the end: on the shared demo server every
// spec's checkout would otherwise offer it.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const SLUG = 'the-quiet-engineer-paperback'; // ₹349: ₹40 to deliver, free to collect

test('an admin adds a pickup point; a customer collects an order with the code', async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const name = `Bazaar Pickup ${Date.now().toString(36)}`;
  let pointId;
  try {
    await admin.goto('/admin/delivery');
    const panel = admin.getByRole('region', { name: 'Click and collect' });
    await panel.getByRole('button', { name: 'Add a pickup point' }).click();
    const form = panel.getByRole('form', { name: 'New pickup point' });
    await form.getByLabel('Name of the place').fill(name);
    await form.getByLabel('Phone').fill('9876500000');
    await form.getByLabel('Address', { exact: true }).fill('80 Feet Road, Koramangala');
    await form.getByLabel('PIN code').fill('560034');
    await form.getByLabel('City').fill('Bengaluru');
    await form.getByLabel('State').fill('Karnataka');
    await form.getByLabel('Opening hours').fill('Mon–Sat 10 am–7 pm');
    await form.getByRole('button', { name: 'Add pickup point' }).click();
    await expect(panel.getByRole('status')).toHaveText('Pickup point added.');
    pointId = (await (await admin.request.get('/api/pickup-points')).json()).items.find((p) => p.name === name).id;

    // A customer picks it at checkout and pays when collecting.
    await page.request.post('/api/auth/register', {
      data: { name: 'Kabir Shah', email: `pickup-${Date.now().toString(36)}@example.com`, password: 'password123' },
    });
    await page.goto(`/p/${SLUG}`);
    await page.getByRole('button', { name: 'Add to cart' }).first().click();
    await page.goto('/checkout');
    await page.getByRole('radio', { name: new RegExp(`Pick up from ${name}`) }).check();
    await page.getByLabel('Mobile number').fill('9876543210');
    await page.getByRole('radio', { name: /Pay at pickup/ }).check();
    await page.getByRole('button', { name: 'Place order · ₹349' }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f]{24}$/);
    const pickup = page.getByRole('region', { name: 'Pickup' });
    await expect(pickup).toContainText(name);
    const code = (await pickup.locator('.pickup-code strong').textContent()).trim();
    expect(code).toMatch(/^\d{6}$/);
    const orderId = page.url().split('/').pop();

    // The admin marks it ready, then collected with the customer's code.
    await admin.goto(`/admin/orders/${orderId}`);
    await admin.getByRole('button', { name: 'Mark ready for pickup' }).click();
    await expect(admin.locator('.order-head .status')).toHaveText('Ready for pickup');
    const collect = admin.getByRole('form', { name: 'Mark collected' });
    await collect.getByLabel("Customer's pickup code").fill(code === '000000' ? '111111' : '000000');
    await collect.getByRole('button', { name: 'Mark collected' }).click();
    await expect(admin.getByRole('alert')).toHaveText("That pickup code doesn't match this order");
    await collect.getByLabel("Customer's pickup code").fill(code);
    await collect.getByRole('button', { name: 'Mark collected' }).click();
    await expect(admin.locator('.order-head .status')).toHaveText('Collected');

    await page.reload();
    await expect(page.locator('.order-head .status')).toHaveText('Collected');
  } finally {
    if (pointId) {
      await admin.request.put(`/api/admin/pickup-points/${pointId}`, {
        data: {
          place: {
            name,
            phone: '9876500000',
            line1: '80 Feet Road, Koramangala',
            city: 'Bengaluru',
            state: 'Karnataka',
            pincode: '560034',
          },
          hours: 'Mon–Sat 10 am–7 pm',
          active: false,
        },
      });
    }
  }
});
