import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseCsv } from '../src/routes/productImport.js';

let t;
let admin;
let customer;
const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10); // India time
const GSTIN = '29ABCDE1234F1ZW';
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
});
after(() => t.stop());

async function placeOrder(lines, state) {
  const items = [];
  for (const [slug, qty] of lines) {
    items.push({ productId: (await t.db.collection('products').findOne({ slug }))._id.toString(), qty });
  }
  const quote = await customer('GET', `/cart?items=${items.map((i) => `${i.productId}:${i.qty}`).join(',')}`);
  const res = await customer('POST', '/orders', {
    items,
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
  return res.body;
}
// parseCsv (from the product import) reads quoted cells with commas in them, and drops the byte-order mark.
const csvRows = (res) => parseCsv(res.body.toString('utf8').trim());
const exportFile = (q) => admin('GET', `/admin/orders/export?from=${today}&to=${today}${q}`);

let before_; // placed while GST was off
let intra; // phone (18%) and books (0%) to Karnataka, the store's state
let inter; // phone to Kerala
test('orders placed with GST on get tax columns; others leave them empty', async () => {
  before_ = await placeOrder([['the-quiet-engineer-paperback', 1]], 'Karnataka');
  const { categories } = (await admin('GET', '/admin/gst')).body;
  const books = categories.find((c) => c.name === 'Books');
  const saved = await admin('PUT', '/admin/gst', {
    enabled: true,
    gstin: GSTIN,
    legalName: 'Bazaar Retail',
    address: 'Bengaluru',
    state: 'Karnataka',
    defaultRate: 18,
    categories: [{ id: books.id, rate: 0, hsn: '4901' }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  intra = await placeOrder(
    [
      ['orbit-a14-4gb-ram-64gb', 1],
      ['the-quiet-engineer-paperback', 2],
    ],
    'Karnataka',
  );
  inter = await placeOrder([['orbit-a14-4gb-ram-64gb', 1]], 'Kerala');
  const cancelled = await placeOrder([['orbit-a14-4gb-ram-64gb', 1]], 'Kerala');
  await customer('POST', `/orders/${cancelled.id}/cancel`);

  const [header, ...lines] = csvRows(await exportFile(''));
  const col = (name) => header.indexOf(name);
  const row = (order) => lines.find((l) => l[0] === String(order.number));
  assert.deepEqual(
    ['Place of supply', 'Taxable value (₹)', 'CGST (₹)', 'SGST (₹)', 'IGST (₹)'].map(col),
    [14, 15, 16, 17, 18],
  );
  assert.deepEqual(row(before_).slice(14, 19), ['', '', '', '', '']);
  // ₹8,999 at 18% (₹7,626.27 + ₹1,372.73) and ₹698 of books at 0%; same state, so CGST + SGST.
  assert.deepEqual(row(intra).slice(14, 19), ['Karnataka', '8324.27', '686.36', '686.37', '0.00']);
  assert.deepEqual(row(inter).slice(14, 19), ['Kerala', '7626.27', '0.00', '0.00', '1372.73']);
});

test('the GST summary adds up sold orders by place of supply and rate', async () => {
  const res = await exportFile('&report=gst');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), new RegExp(`gst-summary-${today}-to-${today}\\.csv`));
  const [header, ...lines] = csvRows(res);
  assert.deepEqual(header, [
    'Place of supply',
    'State code',
    'GST rate (%)',
    'Orders',
    'Taxable value (₹)',
    'CGST (₹)',
    'SGST (₹)',
    'IGST (₹)',
    'Total tax (₹)',
  ]);
  // The cancelled order and the one placed before GST are left out.
  assert.deepEqual(lines, [
    ['Karnataka', '29', '0', '1', '698.00', '0.00', '0.00', '0.00', '0.00'],
    ['Karnataka', '29', '18', '1', '7626.27', '686.36', '686.37', '0.00', '1372.73'],
    ['Kerala', '32', '18', '1', '7626.27', '0.00', '0.00', '1372.73', '1372.73'],
  ]);

  // The status choice doesn't narrow the summary (it's always sales); a bad report name is refused.
  assert.deepEqual(csvRows(await exportFile('&report=gst&status=cancelled')).slice(1), lines);
  assert.match((await exportFile('&report=tax')).body.error, /Choose a report/);
});
