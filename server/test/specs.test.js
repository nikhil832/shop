import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { specsFromText, specsText } from '../src/specs.js';
import { parseCsv } from '../src/routes/productImport.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
let book;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
  book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const specs = [
  { name: 'Pages', value: '320' },
  { name: 'Binding', value: 'Paperback' },
  { name: 'Language', value: 'English' },
];

test('an admin sets specifications; the product page, compare and search engines get them in order', async () => {
  const res = await admin('PATCH', `/admin/products/${book._id}`, {
    specs: [{ name: ' Pages ', value: ' 320 ' }, ...specs.slice(1)],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.specs, specs); // trimmed
  assert.deepEqual((await t.call('GET', `/products/${book.slug}`)).body.specs, specs);
  const compared = (await t.call('GET', `/compare?slugs=${book.slug},monsoon-stories-hardcover`)).body.items;
  assert.deepEqual(compared[0].specs, specs);
  assert.deepEqual(compared[1].specs, []);

  const entry = await t.db.collection('activity').findOne({ 'changes.field': 'Specifications' });
  assert.deepEqual(
    entry.changes.find((c) => c.field === 'Specifications'),
    { field: 'Specifications', from: '', to: 'Pages: 320 | Binding: Paperback | Language: English' },
  );
  // A copy has them too; other saves keep them.
  assert.deepEqual((await admin('POST', `/admin/products/${book._id}/duplicate`)).body.specs, specs);
  assert.deepEqual((await admin('PATCH', `/admin/products/${book._id}`, { stock: 80 })).body.specs, specs);
});

test('the sample phones and laptops come with specifications', async () => {
  const phone = (await t.call('GET', '/products/voltix-nova-5g-8gb-ram-128gb')).body;
  assert.deepEqual(phone.specs[0], { name: 'RAM', value: '8 GB' });
  assert.deepEqual((await t.call('GET', '/products/stride-running-shoes')).body.specs, []);
});

test('specifications are checked', async () => {
  const save = (list) => admin('PATCH', `/admin/products/${book._id}`, { specs: list });
  for (const [list, message] of [
    [[{ name: '', value: '1' }], /Name each specification/],
    [[{ name: 'Pages', value: ' ' }], /Give each specification a value/],
    [[{ name: 'Size: big', value: '1' }], /can't contain a colon/],
    [[{ name: 'Pages', value: '1 | 2' }], /can't contain "\|"/],
    [
      [
        { name: 'Pages', value: '1' },
        { name: 'pages', value: '2' },
      ],
      /a different name/,
    ],
    [Array.from({ length: 21 }, (_, i) => ({ name: `Fact ${i}`, value: 'x' })), /At most 20/],
    [[{ name: 'x'.repeat(41), value: '1' }], /at most 40/],
  ]) {
    const res = await save(list);
    assert.equal(res.status, 400, JSON.stringify(list).slice(0, 80));
    assert.match(res.body.error, message);
  }
  assert.equal((await customer('PATCH', `/admin/products/${book._id}`, { specs: [] })).status, 403);
  assert.deepEqual((await t.db.collection('products').findOne({ _id: book._id })).specs, specs);
});

test('the spreadsheet has a Specifications column that reads back the same, and checks what it gets', async () => {
  const csv = (await admin('GET', '/admin/products/export')).body.toString('utf8');
  const rows = parseCsv(csv);
  const at = rows[0].indexOf('Specifications');
  assert.equal(at, rows[0].indexOf('Description') + 1); // added after the earlier columns, which keep their places
  const row = rows.find((r) => r[0] === book.slug && !r[1]);
  assert.equal(row[at], 'Pages: 320 | Binding: Paperback | Language: English');

  const head = rows[0].join(',');
  const importAs = (cell) =>
    admin(
      'POST',
      '/admin/products/import',
      Buffer.from(`${head}\r\n${book.slug},,,,,,,,,,,,"${cell}"\r\n`),
      'text/csv',
    );
  let res = await importAs('Pages: 336 | Binding: Paperback | Language: English');
  assert.equal(res.status, 200);
  assert.equal(res.body.rows[0].action, 'update');
  assert.deepEqual(res.body.rows[0].changes[0].to[0], { name: 'Pages', value: '336' });
  res = await importAs('Pages 336');
  assert.equal(res.body.rows[0].action, 'error');
  assert.match(res.body.rows[0].error, /Name: Value/);

  assert.deepEqual(specsFromText('RAM: 8 GB | Time: 10:30 '), [
    { name: 'RAM', value: '8 GB' },
    { name: 'Time', value: '10:30' },
  ]);
  assert.equal(specsText([]), '');
});

test('product pages give search engines the specifications', async () => {
  // preview.js builds the JSON-LD only for the built client; its function is tested directly.
  const { productJsonLd } = await import('../src/preview.js');
  const doc = await t.db.collection('products').findOne({ _id: book._id });
  const data = productJsonLd(doc, 'https://shop.example');
  assert.deepEqual(data.additionalProperty[0], { '@type': 'PropertyValue', name: 'Pages', value: '320' });
});
