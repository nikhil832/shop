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
    'Credit notes',
    'Taxable value (₹)',
    'CGST (₹)',
    'SGST (₹)',
    'IGST (₹)',
    'Total tax (₹)',
  ]);
  // The cancelled order and the one placed before GST are left out.
  assert.deepEqual(lines, [
    ['Karnataka', '29', '0', '1', '0', '698.00', '0.00', '0.00', '0.00', '0.00'],
    ['Karnataka', '29', '18', '1', '0', '7626.27', '686.36', '686.37', '0.00', '1372.73'],
    ['Kerala', '32', '18', '1', '0', '7626.27', '0.00', '0.00', '1372.73', '1372.73'],
  ]);

  // The status choice doesn't narrow the summary (it's always sales); a bad report name is refused.
  assert.deepEqual(csvRows(await exportFile('&report=gst&status=cancelled')).slice(1), lines);
  assert.match((await exportFile('&report=tax')).body.error, /Choose a report/);
});

// Stage 50: the phone of the Karnataka order comes back. Its credit note takes it off the summary for today.
let ret;
test('an approved return of an order placed with GST on gets a numbered credit note', async () => {
  for (const order of [intra, before_]) {
    for (const status of ['shipped', 'delivered']) {
      assert.equal((await admin('POST', `/admin/orders/${order.id}/status`, { status })).status, 200);
    }
  }
  const asked = await customer('POST', `/orders/${intra.id}/returns`, {
    items: [{ index: 0, qty: 1 }],
    reason: 'damaged',
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  assert.equal(asked.body.creditNote, null);
  // None until approved.
  assert.equal((await customer('GET', `/orders/${intra.id}/credit-notes/${asked.body.id}`)).status, 404);

  const approved = await admin('POST', `/admin/returns/${asked.body.id}/approve`);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.creditNote.number, 'CN-1');
  ret = approved.body;

  const note = await customer('GET', `/orders/${intra.id}/credit-notes/${ret.id}`);
  assert.equal(note.status, 200, JSON.stringify(note.body));
  assert.equal(note.body.number, 'CN-1');
  assert.equal(note.body.order.number, intra.number);
  assert.equal(note.body.email, 'asha@example.com');
  assert.equal(note.body.seller.gstin, GSTIN);
  assert.equal(note.body.intraState, true);
  // ₹8,999 refunded at 18%, as on the invoice: ₹7,626.27 + ₹686.36 CGST + ₹686.37 SGST.
  assert.deepEqual(
    note.body.lines.map(({ rate, qty, value, taxable, cgst, sgst, igst }) => ({
      rate,
      qty,
      value,
      taxable,
      cgst,
      sgst,
      igst,
    })),
    [{ rate: 18, qty: 1, value: 899900, taxable: 762627, cgst: 68636, sgst: 68637, igst: 0 }],
  );
  assert.equal(note.body.totals.value, ret.refund);

  // The admin sees it too, with the customer's email; another customer doesn't.
  const forAdmin = await admin('GET', `/admin/orders/${intra.id}/credit-notes/${ret.id}`);
  assert.equal(forAdmin.body.email, 'asha@example.com');
  const stranger = t.browser();
  await stranger('POST', '/auth/register', { name: 'Ravi K', email: 'ravi@example.com', password: 'password123' });
  assert.equal((await stranger('GET', `/orders/${intra.id}/credit-notes/${ret.id}`)).status, 404);
  assert.equal((await customer('GET', `/orders/${intra.id}/returns`)).body.returns[0].creditNote.number, 'CN-1');

  // An order placed while GST was off gets no credit note, and doesn't use up a number.
  const plain = await customer('POST', `/orders/${before_.id}/returns`, {
    items: [{ index: 0, qty: 1 }],
    reason: 'damaged',
  });
  const plainApproved = await admin('POST', `/admin/returns/${plain.body.id}/approve`);
  assert.equal(plainApproved.body.creditNote, null);
  assert.equal((await customer('GET', `/orders/${before_.id}/credit-notes/${plain.body.id}`)).status, 404);
});

test('the GST summary takes off credit notes issued in its dates', async () => {
  const [header, ...lines] = csvRows(await exportFile('&report=gst'));
  assert.equal(header[4], 'Credit notes');
  assert.deepEqual(lines, [
    ['Karnataka', '29', '0', '1', '0', '698.00', '0.00', '0.00', '0.00', '0.00'],
    ['Karnataka', '29', '18', '1', '1', '0.00', '0.00', '0.00', '0.00', '0.00'],
    ['Kerala', '32', '18', '1', '0', '7626.27', '0.00', '0.00', '1372.73', '1372.73'],
  ]);

  // A credit note counts in the dates it was issued, not the order's: moved to tomorrow, today's summary is gross
  // again and tomorrow's has only the credit note.
  const tomorrow = new Date(Date.now() + 330 * 60_000 + 86_400_000).toISOString().slice(0, 10);
  await t.db
    .collection('returns')
    .updateOne({ 'creditNote.seq': 1 }, { $set: { 'creditNote.date': new Date(Date.now() + 86_400_000) } });
  const todays = csvRows(await exportFile('&report=gst')).slice(1);
  assert.deepEqual(todays[1], ['Karnataka', '29', '18', '1', '0', '7626.27', '686.36', '686.37', '0.00', '1372.73']);
  const next = await admin('GET', `/admin/orders/export?from=${tomorrow}&to=${tomorrow}&report=gst`);
  assert.deepEqual(csvRows(next).slice(1), [
    ['Karnataka', '29', '18', '0', '1', '-7626.27', '-686.36', '-686.37', '0.00', '-1372.73'],
  ]);
});
