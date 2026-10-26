import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startTestServer } from './helpers.js';
import { findState, gstInvoice, gstinCheckChar, gstinProblem, INDIAN_STATES } from '../src/gst.js';

const GSTIN = '29ABCDE1234F1ZW'; // a made-up Karnataka GSTIN with a correct check character

test('states: proper names from what people type, and the list matches the client’s', async () => {
  assert.equal(findState('karnataka').name, 'Karnataka');
  assert.equal(findState('  TAMILNADU ').name, 'Tamil Nadu');
  assert.equal(findState('Orissa').name, 'Odisha');
  assert.equal(findState('New Delhi').code, '07');
  assert.equal(findState('Jammu & Kashmir').code, '01');
  assert.equal(findState('Narnia'), null);
  assert.equal(INDIAN_STATES.length, 36);
  const client = await readFile(new URL('../../client/src/states.js', import.meta.url), 'utf8');
  assert.deepEqual(
    [...client.matchAll(/'([^']+)',/g)].map((m) => m[1]),
    INDIAN_STATES.map((s) => s.name),
  );
});

test('GSTINs: format, check character and state code', () => {
  assert.equal(gstinProblem('27AAPFU0939F1ZV'), null); // a published example
  assert.equal(gstinProblem(GSTIN), null);
  assert.match(gstinProblem('29ABCDE1234F1ZX'), /typo/);
  assert.match(gstinProblem('29ABCDE1234F1Z'), /15 characters/);
  assert.match(gstinProblem(`99ABCDE1234F1Z${gstinCheckChar('99ABCDE1234F1Z')}`), /not a state code/);
});

// An order as stored: two lines, delivery, maybe a coupon, placed with GST on by a Karnataka store.
const order = (fields) => ({
  items: [
    { title: 'Shoes', price: 249900, qty: 1, gstRate: 5, hsn: '6404' },
    { title: 'Book', price: 34900, qty: 2, gstRate: 0, hsn: '4901' },
  ],
  subtotal: 319700,
  delivery: 4000,
  discount: 0,
  total: 323700,
  address: { state: 'Karnataka' },
  gst: {
    gstin: GSTIN,
    legalName: 'Bazaar Retail',
    address: 'Bengaluru',
    state: 'Karnataka',
    stateCode: '29',
    deliveryRate: 5,
  },
  ...fields,
});

test('the invoice splits each tax-inclusive line; same state is CGST + SGST, another state IGST', () => {
  const inv = gstInvoice(order());
  assert.equal(inv.intraState, true);
  assert.deepEqual(inv.placeOfSupply, { name: 'Karnataka', code: '29' });
  const [shoes, book, delivery] = inv.lines;
  assert.deepEqual(
    { ...shoes, title: undefined },
    {
      title: undefined,
      hsn: '6404',
      rate: 5,
      qty: 1,
      value: 249900,
      taxable: 238000,
      tax: 11900,
      cgst: 5950,
      sgst: 5950,
      igst: 0,
    },
  );
  assert.equal(book.tax, 0);
  assert.equal(delivery.title, 'Delivery');
  assert.equal(delivery.rate, 5);
  assert.equal(inv.totals.value, 323700); // the lines add up to what the customer paid
  assert.equal(inv.totals.taxable + inv.totals.tax, 323700);
  assert.deepEqual(
    inv.byRate.map((r) => r.rate),
    [0, 5],
  );

  const kerala = gstInvoice(order({ address: { state: 'Kerala' } }));
  assert.equal(kerala.intraState, false);
  assert.equal(kerala.totals.cgst + kerala.totals.sgst, 0);
  assert.equal(kerala.totals.igst, inv.totals.tax);
  assert.equal(gstInvoice({ ...order(), gst: undefined }), null);
});

test('coupons lower the taxable values in proportion; free delivery lowers the delivery', () => {
  const coupon = gstInvoice(order({ discount: 31900, total: 291800, coupon: { code: 'TEN', type: 'percent' } }));
  assert.equal(coupon.totals.value, 291800);
  assert.equal(coupon.lines[0].value + coupon.lines[1].value, 319700 - 31900);
  assert.equal(coupon.lines[2].value, 4000);

  const free = gstInvoice(order({ discount: 4000, total: 319700, coupon: { code: 'SHIP', type: 'free_delivery' } }));
  assert.equal(free.lines.length, 2); // no delivery line
  assert.equal(free.totals.value, 319700);

  const odd = gstInvoice(
    order({ items: [{ title: 'Ring', price: 1000001, qty: 1, gstRate: 3, hsn: '7113' }], delivery: 0, total: 1000001 }),
  );
  assert.equal(odd.lines[0].taxable + odd.lines[0].tax, 1000001);
});

// ---- Settings and orders, through the API ----

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
});
after(() => t.stop());

const SETTINGS = {
  enabled: true,
  gstin: GSTIN,
  legalName: 'Bazaar Retail Pvt Ltd',
  address: '12 MG Road, Bengaluru 560001',
  state: 'karnataka',
  defaultRate: 18,
};

async function placeOrder(slug, state = 'Karnataka') {
  const product = await t.db.collection('products').findOne({ slug });
  const quote = await customer('GET', `/cart?items=${product._id}:1`);
  const res = await customer('POST', '/orders', {
    items: [{ productId: product._id.toString(), qty: 1 }],
    address: {
      name: 'Asha Rao',
      phone: '9876543210',
      line1: '1 Main Road',
      city: 'Somewhere',
      state,
      pincode: '560001',
    },
    expectedTotal: quote.body.total,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return (await customer('GET', `/orders/${res.body.id}`)).body;
}

test('addresses need a real state, stored by its proper name', async () => {
  const address = (state) => ({ name: 'Asha', phone: '9876543210', line1: 'x', city: 'y', state, pincode: '600001' });
  const bad = await customer('PUT', '/account/address', { address: address('Narnia') });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Choose a state or union territory/);
  const ok = await customer('PUT', '/account/address', { address: address('tamilnadu') });
  assert.equal(ok.status, 200);
  assert.equal((await t.db.collection('users').findOne({ email: 'asha@example.com' })).address.state, 'Tamil Nadu');
});

test('GST is off by default: invoices as before', async () => {
  const res = await admin('GET', '/admin/gst');
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.categories.length, 6);
  assert.deepEqual(res.body.rates, [0, 0.25, 3, 5, 18, 40]);
  assert.equal((await placeOrder('the-quiet-engineer-paperback')).gstInvoice, null);
  assert.equal((await customer('GET', '/admin/gst')).status, 403);
});

test('switching GST on needs the store’s details, a valid GSTIN from its state, and known rates', async () => {
  const put = (body) => admin('PUT', '/admin/gst', body);
  assert.match(
    (await put({ enabled: true })).body.error,
    /enter the GSTIN, business name, address, state, default rate/,
  );
  assert.match((await put({ ...SETTINGS, gstin: '29ABCDE1234F1ZX' })).body.error, /typo/);
  assert.match((await put({ ...SETTINGS, state: 'Kerala' })).body.error, /from Kerala starts with 32/);
  assert.match((await put({ ...SETTINGS, defaultRate: 12 })).body.error, /Choose a rate/);
  const { categories } = (await admin('GET', '/admin/gst')).body;
  const books = categories.find((c) => c.name === 'Books');
  assert.match(
    (await put({ ...SETTINGS, categories: [{ id: books.id, rate: 0, hsn: '49' }] })).body.error,
    /4, 6 or 8 digits/,
  );

  const res = await put({
    ...SETTINGS,
    categories: [
      { id: books.id, rate: 0, hsn: '4901' },
      { id: categories.find((c) => c.name === 'Fashion').id, rate: 5, hsn: '6404' },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.state, 'Karnataka');
  assert.equal(res.body.gstin, GSTIN);
  assert.deepEqual(
    res.body.categories.find((c) => c.name === 'Books'),
    { id: books.id, name: 'Books', rate: 0, hsn: '4901' },
  );
  const log = (await admin('GET', '/admin/activity?area=settings')).body.items[0];
  assert.equal(log.action, 'Changed GST settings');
  assert.ok(log.changes.some((c) => c.field === 'GST on' && c.to === 'yes'));
  assert.ok(log.changes.some((c) => c.field === 'Books: rate' && c.to === '0%'));
});

test('orders placed with GST on get tax invoices that keep their rates', async () => {
  const order = await placeOrder('the-quiet-engineer-paperback');
  const inv = order.gstInvoice;
  assert.equal(inv.seller.gstin, GSTIN);
  assert.equal(inv.seller.legalName, 'Bazaar Retail Pvt Ltd');
  assert.equal(inv.intraState, true);
  assert.equal(inv.lines[0].hsn, '4901');
  assert.equal(inv.lines[0].rate, 0);
  assert.equal(inv.totals.value, order.total);

  // A phone: no rate of its own, so the default 18%; to Kerala, so IGST.
  const phone = await placeOrder('orbit-a14-4gb-ram-64gb', 'Kerala');
  assert.equal(phone.gstInvoice.lines[0].rate, 18);
  assert.equal(phone.gstInvoice.intraState, false);
  assert.equal(phone.gstInvoice.totals.igst, phone.gstInvoice.totals.tax);
  assert.ok(phone.gstInvoice.totals.tax > 0);

  // Rates changed later don't change invoices already made; GST off again: new orders have none.
  await admin('PUT', '/admin/gst', { ...SETTINGS, enabled: false, defaultRate: 5 });
  assert.equal((await customer('GET', `/orders/${phone.id}`)).body.gstInvoice.lines[0].rate, 18);
  assert.equal((await placeOrder('orbit-a14-4gb-ram-64gb')).gstInvoice, null);
});
