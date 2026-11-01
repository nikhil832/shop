import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Filter by specification (stage 138). The sample catalog gives specs to three phones (RAM 4/8/12 GB, Storage
// 64/128/256 GB, Battery 5000 mAh twice) and two laptops.
let t;
before(async () => {
  t = await startTestServer();
});
after(() => t.stop());

const list = async (params) => (await t.call('GET', `/products?${new URLSearchParams(params)}`)).body;
const facet = (body, name) => body.specs.find((s) => s.name === name);
const counts = (f) => Object.fromEntries(f.values.map((v) => [v.value, v.count]));

test('the facet lists shared specifications with counts, in number order', async () => {
  const body = await list({ category: 'mobiles' });
  assert.deepEqual(
    body.specs.map((s) => s.name),
    ['Battery', 'Display', 'Main camera', 'RAM', 'Storage'],
  );
  assert.deepEqual(counts(facet(body, 'RAM')), { '4 GB': 1, '8 GB': 1, '12 GB': 1 });
  assert.deepEqual(counts(facet(body, 'Battery')), { '4800 mAh, 67 W charging': 1, '5000 mAh': 2 });
  // Laptops and phones together: RAM has five values, in number order.
  const all = await list({});
  assert.deepEqual(
    facet(all, 'RAM').values.map((v) => v.value),
    ['4 GB', '8 GB', '12 GB', '16 GB', '32 GB'],
  );
  // A category without specs has none.
  assert.deepEqual((await list({ category: 'books' })).specs, []);
});

test('values of one name are alternatives, names must all match, ignoring case', async () => {
  const one = await list({ category: 'mobiles', spec: 'RAM:8 GB' });
  assert.deepEqual(
    one.items.map((p) => p.title),
    ['Voltix Nova 5G (8GB RAM, 128GB)'],
  );
  const either = await t.call('GET', '/products?category=mobiles&spec=ram:8%20gb&spec=RAM:12%20GB');
  assert.equal(either.body.total, 2);
  // The RAM facet still offers 4 GB (its own choices are ignored), with the chosen ones marked.
  const ram = facet(either.body, 'RAM');
  assert.deepEqual(counts(ram), { '4 GB': 1, '8 GB': 1, '12 GB': 1 });
  assert.deepEqual(
    ram.values.filter((v) => v.chosen).map((v) => v.value),
    ['8 GB', '12 GB'],
  );
  // Storage counts follow the RAM choice.
  assert.deepEqual(counts(facet(either.body, 'Storage')), { '64 GB': 0, '128 GB': 1, '256 GB': 1 });

  const both = await t.call('GET', '/products?spec=RAM:12%20GB&spec=Storage:128%20GB');
  assert.equal(both.body.total, 0);
  assert.equal((await t.call('GET', '/products?spec=Battery:5000%20mAh&inStock=1')).body.total, 2);
});

test('choices are checked, and a filtered search is not counted as a plain search', async () => {
  for (const bad of ['RAM', ':8 GB', 'RAM:', 'RAM: '.padEnd(200, 'x')]) {
    assert.equal((await t.call('GET', `/products?spec=${encodeURIComponent(bad)}`)).status, 400, bad);
  }
  const many = new URLSearchParams(Array.from({ length: 21 }, (_, i) => ['spec', `RAM:${i} GB`]));
  assert.equal((await t.call('GET', `/products?${many}`)).status, 400);
  // A chosen value no product has is still listed, so it can be unticked.
  const odd = await list({ category: 'mobiles', spec: 'RAM:6 GB' });
  assert.equal(odd.total, 0);
  assert.deepEqual(
    facet(odd, 'RAM').values.find((v) => v.value === '6 GB'),
    { value: '6 GB', count: 0, chosen: true },
  );

  await list({ q: 'voltix', spec: 'RAM:8 GB' });
  assert.equal(await t.db.collection('searchStats').countDocuments({ term: 'voltix' }), 0);
});
