import { test, expect } from '@playwright/test';

// "Add to cart" before every option is chosen says which one is missing, and adds nothing.
async function mustChoose(page, missing) {
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(`Choose a ${missing} first`);
  await expect(page.getByRole('button', { name: 'Buy now' })).toHaveCount(0);
}

// Sample sizes from server/src/seed.js. Shares the demo server with the other files: it buys a few pairs of shoes,
// whose stock no other test counts.
const SHOES = '/p/stride-running-shoes'; // UK 7–10 at ₹2,499
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sizes = (page) => page.getByRole('group', { name: /^Size/ });

test('a size must be chosen; each size is its own cart line and order line', async ({ page }) => {
  // Different prices per size show as "from" until one is chosen.
  await page.goto('/search?q=kurta');
  await expect(page.locator('.card').first()).toContainText('from ₹1,499');
  await page.goto('/p/urbane-women-kurta-set');
  await sizes(page).getByRole('button', { name: 'XL' }).click();
  await expect(page.locator('.product-info .price')).toHaveText('₹1,599');

  await page.goto(SHOES);
  await mustChoose(page, 'size');
  await sizes(page).getByRole('button', { name: 'UK 8' }).click();
  await expect(sizes(page).getByRole('button', { name: 'UK 8' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sizes(page)).toContainText('Size: UK 8');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByRole('link', { name: 'Go to cart (1 added)' })).toBeVisible();
  // Another size starts at none in the cart.
  await sizes(page).getByRole('button', { name: 'UK 9' }).click();
  await expect(page.getByRole('link', { name: /Go to cart/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add to cart' }).click();

  await page.goto('/cart');
  const lines = page.locator('.cart-line');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText('Size: UK 8');
  await expect(lines.nth(1)).toContainText('Size: UK 9');
  await lines
    .nth(1)
    .getByLabel(/Quantity/)
    .selectOption('2');
  await expect(page.getByRole('complementary', { name: 'Order summary' })).toContainText('Total₹7,497');

  // Check out as a new customer.
  await page.getByRole('button', { name: 'Checkout' }).click();
  await page.getByRole('region', { name: 'Your details' }).getByRole('link', { name: 'Log in' }).click();
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Asha Rao');
  await page.getByLabel('Email').fill(`sizes-${unique()}@example.com`);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/checkout');
  await expect(page.locator('.checkout-items')).toContainText('Stride Running Shoes (Size: UK 9) × 2');
  for (const [label, value] of Object.entries({
    'Mobile number': '9876543210',
    'Address (house, street, area)': '12 MG Road',
    City: 'Bengaluru',
    State: 'Karnataka',
    'PIN code': '560001',
  })) {
    await page.getByLabel(label).fill(value);
  }
  await page.getByRole('radio', { name: /Cash on Delivery/ }).check();
  await page.getByRole('button', { name: 'Place order · ₹7,497' }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f]{24}$/);
  await expect(page.getByText('Stride Running Shoes (Size: UK 8)')).toBeVisible();
  await expect(page.getByText('Stride Running Shoes (Size: UK 9)')).toBeVisible();
});

test('an admin adds a product in two colours; the store offers both', async ({ page }) => {
  const title = `Ziva Scarf ${unique()}`;
  await page.goto('/login?next=/admin/products/new');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Add product' })).toBeVisible();

  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Brand').fill('Ziva');
  await page.getByLabel('Category').selectOption({ label: 'Fashion' });
  await page.getByLabel(/Comes in sizes, colours/).check();
  // The product's own price and stock give way to the variants'.
  await expect(page.getByLabel('Price (₹)')).toHaveCount(0);
  await page.getByLabel('Option name').fill('Colour');
  await page.getByLabel('Label of variant 1').fill('Red');
  await page.getByLabel('Price of variant 1').fill('699');
  await page.getByLabel('MRP of variant 1').fill('999');
  await page.getByLabel('Stock of variant 1').fill('4');
  await page.getByRole('button', { name: 'Add a variant' }).click();
  await page.getByLabel('Label of variant 2').fill('Blue');
  await page.getByLabel('Price of variant 2').fill('599');
  await page.getByLabel('MRP of variant 2').fill('999');
  await page.getByLabel('Stock of variant 2').fill('0');
  await page.getByRole('button', { name: 'Add product' }).click();

  await expect(page).toHaveURL('/admin/products');
  await page.getByRole('searchbox').fill(title);
  await page.getByRole('searchbox').press('Enter');
  const row = page.getByRole('row', { name: new RegExp(title) });
  await expect(row).toContainText('from ₹599');
  await expect(row).toContainText('4 in 2 colours');
  await expect(row).toContainText('Red: 4 · Blue: 0');

  await row.getByRole('link', { name: title }).click();
  await page.getByRole('link', { name: 'View in store ↗' }).evaluate((a) => a.removeAttribute('target'));
  await page.getByRole('link', { name: 'View in store ↗' }).click();
  const colours = page.getByRole('group', { name: /^Colour/ });
  await mustChoose(page, 'colour');
  await colours.getByRole('button', { name: 'Red' }).click();
  await expect(page.getByRole('button', { name: 'Add to cart' })).toBeEnabled();
  // Sold-out Blue can be chosen, to ask for an email when it's back.
  await expect(colours.getByRole('button', { name: 'Blue (sold out)' })).toBeVisible();
  await colours.getByRole('button', { name: /Blue/ }).click();
  await expect(page.getByRole('button', { name: 'Add to cart' })).toHaveCount(0);
  await page.getByRole('button', { name: "Email me when Blue's back" }).click();
  await expect(page.getByRole('status')).toHaveText(`We'll email ${ADMIN.email} when Blue's back in stock.`);
  // Still on after reloading, and only for Blue.
  await page.reload();
  await page
    .getByRole('group', { name: /^Colour/ })
    .getByRole('button', { name: /Blue/ })
    .click();
  await expect(page.getByRole('button', { name: 'Cancel alert' })).toBeVisible();
  await page
    .getByRole('group', { name: /^Colour/ })
    .getByRole('button', { name: 'Red' })
    .click();
  await expect(page.getByRole('button', { name: 'Cancel alert' })).toHaveCount(0);
});

test("choosing a colour shows that colour's photos", async ({ page }) => {
  const { images, variants } = await (await page.request.get('/api/products/ziva-women-handbag')).json();
  await page.goto('/p/ziva-women-handbag');
  const main = page.locator('.gallery-main img');
  const thumbs = page.getByRole('button', { name: /^Show image/ });
  await expect(thumbs).toHaveCount(images.length);

  await page
    .getByRole('group', { name: /^Colour/ })
    .getByRole('button', { name: 'Tan' })
    .click();
  const tan = variants.find((v) => v.label === 'Tan');
  await expect(main).toHaveAttribute('src', tan.images[0]);
  await expect(main).toHaveAccessibleName('Ziva Women Handbag, Tan');
  await expect(thumbs).toHaveCount(tan.images.length > 1 ? tan.images.length : 0);

  await page
    .getByRole('group', { name: /^Colour/ })
    .getByRole('button', { name: 'Black' })
    .click();
  const black = variants.find((v) => v.label === 'Black');
  await expect(main).toHaveAttribute('src', black.images[0]);
  await expect(thumbs).toHaveCount(black.images.length);
});

test('two options: waists depend on the colour, and the choice names both', async ({ page }) => {
  // Colour × Waist from the sample data: Blue 30 (sold out), 32, 34 (₹1,299); Black 30, 32; no Black 34.
  const { images } = await (await page.request.get('/api/products/urbane-men-slim-fit-jeans')).json();
  await page.goto('/p/urbane-men-slim-fit-jeans');
  const colour = page.getByRole('group', { name: /^Colour/ });
  const waist = page.getByRole('group', { name: /^Waist/ });
  await mustChoose(page, 'colour and waist');

  await colour.getByRole('button', { name: 'Blue' }).click();
  await mustChoose(page, 'waist');
  await expect(waist.getByRole('button', { name: '30 (sold out)' })).toBeEnabled();
  await waist.getByRole('button', { name: '34' }).click();
  await expect(page.locator('.product-info .price')).toHaveText('₹1,299');
  await expect(page.getByRole('button', { name: 'Add to cart' })).toBeEnabled();

  // Black has no 34: switching colour clears the waist, and 34 can't be chosen.
  await colour.getByRole('button', { name: 'Black' }).click();
  await expect(page.locator('.gallery-main img')).toHaveAttribute('src', images[1]);
  await expect(waist.getByRole('button', { name: '34 (not available)' })).toBeDisabled();
  await mustChoose(page, 'waist');
  await waist.getByRole('button', { name: '32' }).click();
  await expect(waist).toContainText('Waist: 32');
  await page.getByRole('button', { name: 'Add to cart' }).click();

  await page.goto('/cart');
  await expect(page.locator('.cart-line').filter({ hasText: 'Slim Fit Jeans' })).toContainText(
    'Colour: Black, Waist: 32',
  );
});

test('an admin builds a colour × size grid with "Add missing combinations"', async ({ page }) => {
  const title = `Urbane Chinos ${unique()}`;
  await page.goto('/login?next=/admin/products/new');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Brand').fill('Urbane');
  await page.getByLabel('Category').selectOption({ label: 'Fashion' });
  await page.getByLabel(/Comes in sizes, colours/).check();
  await page.getByLabel('Option name').fill('Colour');
  await page.getByRole('button', { name: 'Add a second option' }).click();
  await page.getByLabel('Second option').fill('Size');

  await page.getByLabel('Colour of variant 1').fill('Khaki');
  await page.getByLabel('Size of variant 1').fill('30');
  await page.getByLabel('Price of variant 1').fill('999');
  await page.getByLabel('MRP of variant 1').fill('1499');
  await page.getByLabel('Stock of variant 1').fill('3');
  await page.getByRole('button', { name: 'Add a variant' }).click();
  await page.getByLabel('Colour of variant 2').fill('Navy');
  await page.getByLabel('Size of variant 2').fill('32');
  await page.getByLabel('Price of variant 2').fill('999');
  await page.getByLabel('MRP of variant 2').fill('1499');
  await page.getByLabel('Stock of variant 2').fill('2');
  // Khaki 32 and Navy 30 are added, at the first row's prices and no stock.
  await page.getByRole('button', { name: 'Add missing combinations' }).click();
  await expect(page.getByLabel(/^Colour of variant/)).toHaveCount(4);
  await expect(page.getByLabel('Colour of variant 3')).toHaveValue('Khaki');
  await expect(page.getByLabel('Size of variant 3')).toHaveValue('32');
  await expect(page.getByLabel('Price of variant 4')).toHaveValue('999');
  await page.getByLabel('Stock of variant 3').fill('4');
  await page.getByRole('button', { name: 'Add product' }).click();

  await expect(page).toHaveURL('/admin/products');
  await page.getByRole('searchbox').fill(title);
  await page.getByRole('searchbox').press('Enter');
  const row = page.getByRole('row', { name: new RegExp(title) });
  await expect(row).toContainText('9 in 4 combinations');
  await expect(row).toContainText('Khaki / 30: 3 · Navy / 32: 2 · Khaki / 32: 4 · Navy / 30: 0');
});
