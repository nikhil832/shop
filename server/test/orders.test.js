import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let products;
before(async () => {
  t = await startTestServer();
  products = t.db.collection('products');
});
after(() => t.stop());

// Seed products used here: a ₹349 book (stock 90), a ₹8,999 phone (40), a ₹89,999 phone (3), a sold-out phone.
const BOOK = 'the-quiet-engineer-paperback';
const PHONE = 'orbit-a14-4gb-ram-64gb';
const FOLD = 'orbit-x-fold';
const SOLD_OUT = 'pixelon-9-8gb-ram-256gb';

const idOf = async (slug) => (await products.findOne({ slug }))._id.toString();
const stockOf = async (slug) => (await products.findOne({ slug })).stock;

const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};

async function loggedIn(email) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name: 'Buyer', email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

// Asks for a quote first, like the checkout page, then places the order at the quoted total.
async function placeOrder(call, items) {
  const quote = await call('GET', `/cart?items=${items.map((i) => `${i.productId}:${i.qty}`).join(',')}`);
  return call('POST', '/orders', { items, address, expectedTotal: quote.body.total });
}

test('quotes a cart with current prices, stock problems and delivery charge', async () => {
  const [book, phone, soldOut] = await Promise.all([idOf(BOOK), idOf(PHONE), idOf(SOLD_OUT)]);

  const small = await t.call('GET', `/cart?items=${book}:1`);
  assert.equal(small.status, 200);
  assert.deepEqual(
    { subtotal: small.body.subtotal, delivery: small.body.delivery, total: small.body.total },
    { subtotal: 34900, delivery: 4000, total: 38900 },
  );
  assert.equal(small.body.freeDeliveryMin, 49900);
  assert.equal(small.body.items[0].product.slug, BOOK);
  assert.equal(small.body.canCheckout, true);

  const free = await t.call('GET', `/cart?items=${book}:2`);
  assert.equal(free.body.delivery, 0);
  assert.equal(free.body.total, 69800);

  const problems = await t.call('GET', `/cart?items=${phone}:2,${soldOut}:1,${'0'.repeat(24)}:1`);
  assert.equal(problems.body.subtotal, 2 * 899900 + 5499900);
  assert.deepEqual(
    problems.body.items.map((i) => i.problem),
    [null, 'Out of stock', 'No longer available'],
  );
  assert.equal(problems.body.canCheckout, false);

  const fold = await idOf(FOLD);
  const tooMany = await t.call('GET', `/cart?items=${fold}:5`);
  assert.equal(tooMany.body.items[0].problem, 'Only 3 left');
});

test('rejects invalid cart quotes', async () => {
  const book = await idOf(BOOK);
  for (const items of ['', 'nope:1', `${book}:0`, `${book}:11`, `${book}:1.5`, `${book}:1,${book}:2`]) {
    const res = await t.call('GET', `/cart?items=${items}`);
    assert.equal(res.status, 400, items);
  }
  assert.equal((await t.call('GET', '/cart')).status, 400);
});

test('placing an order needs a login', async () => {
  const res = await t.call('POST', '/orders', {
    items: [{ productId: await idOf(BOOK), qty: 1 }],
    address,
    expectedTotal: 38900,
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Please log in');
  assert.equal((await t.call('GET', '/orders')).status, 401);
});

test('places a COD order: snapshots prices, takes stock and remembers the address', async () => {
  const call = await loggedIn('buyer1@example.com');
  const [book, phone] = await Promise.all([idOf(BOOK), idOf(PHONE)]);
  const before = { book: await stockOf(BOOK), phone: await stockOf(PHONE) };

  const res = await placeOrder(call, [
    { productId: book, qty: 2 },
    { productId: phone, qty: 1 },
  ]);
  assert.equal(res.status, 201);
  const order = res.body;
  assert.equal(order.status, 'placed');
  assert.deepEqual(order.payment, { method: 'cod' });
  assert.equal(order.checkout, null);
  assert.equal(order.number, 100001); // the first order in this database
  assert.deepEqual(
    order.items.map((i) => [i.slug, i.price, i.qty]),
    [
      [BOOK, 34900, 2],
      [PHONE, 899900, 1],
    ],
  );
  assert.deepEqual([order.subtotal, order.delivery, order.total], [969700, 0, 969700]);
  assert.deepEqual(order.address, { ...address, line2: '' });

  assert.equal(await stockOf(BOOK), before.book - 2);
  assert.equal(await stockOf(PHONE), before.phone - 1);
  assert.deepEqual((await call('GET', '/auth/me')).body.user.address, { ...address, line2: '' });

  // A later price change doesn't touch the order.
  await products.updateOne({ slug: BOOK }, { $set: { price: 39900 } });
  const fetched = await call('GET', `/orders/${order.id}`);
  assert.equal(fetched.body.items[0].price, 34900);
  await products.updateOne({ slug: BOOK }, { $set: { price: 34900 } });

  const list = await call('GET', '/orders');
  assert.deepEqual(
    list.body.map((o) => o.id),
    [order.id],
  );
});

test('charges ₹40 delivery below ₹499', async () => {
  const call = await loggedIn('buyer2@example.com');
  const res = await placeOrder(call, [{ productId: await idOf(BOOK), qty: 1 }]);
  assert.equal(res.status, 201);
  assert.deepEqual([res.body.subtotal, res.body.delivery, res.body.total], [34900, 4000, 38900]);
});

test('a short item fails the whole order and changes nothing', async () => {
  const call = await loggedIn('buyer3@example.com');
  const [book, fold] = await Promise.all([idOf(BOOK), idOf(FOLD)]);
  const before = {
    book: await stockOf(BOOK),
    fold: await stockOf(FOLD),
    orders: await t.db.collection('orders').countDocuments(),
  };

  // The book is decremented first inside the transaction; the fold then fails and the book must be rolled back.
  const res = await call('POST', '/orders', {
    items: [
      { productId: book, qty: 1 },
      { productId: fold, qty: 4 },
    ],
    address,
    expectedTotal: 34900 + 4 * 8999900,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Only 3 left of Orbit X Fold');
  assert.equal(await stockOf(BOOK), before.book);
  assert.equal(await stockOf(FOLD), before.fold);
  assert.equal(await t.db.collection('orders').countDocuments(), before.orders);
  assert.equal((await call('GET', '/auth/me')).body.user.address, null);

  const soldOut = await call('POST', '/orders', {
    items: [{ productId: await idOf(SOLD_OUT), qty: 1 }],
    address,
    expectedTotal: 5499900,
  });
  assert.equal(soldOut.status, 409);
  assert.equal(soldOut.body.error, 'Pixelon 9 (8GB RAM, 256GB) is out of stock');
});

test('refuses inactive products and changed prices', async () => {
  const call = await loggedIn('buyer4@example.com');
  const book = await idOf(BOOK);
  const stock = await stockOf(BOOK);

  const changed = await call('POST', '/orders', {
    items: [{ productId: book, qty: 1 }],
    address,
    expectedTotal: 30000,
  });
  assert.equal(changed.status, 409);
  assert.match(changed.body.error, /^Prices have changed/);
  assert.equal(await stockOf(BOOK), stock);

  await products.updateOne({ slug: BOOK }, { $set: { active: false } });
  const inactive = await placeOrder(call, [{ productId: book, qty: 1 }]);
  assert.equal(inactive.status, 409);
  assert.equal(inactive.body.error, 'An item in your cart is no longer available');
  await products.updateOne({ slug: BOOK }, { $set: { active: true } });
  assert.equal(await stockOf(BOOK), stock);
});

test('only the last unit can be bought once when two buyers race for it', async () => {
  await products.updateOne({ slug: FOLD }, { $set: { stock: 1 } });
  const fold = await idOf(FOLD);
  const [a, b] = await Promise.all([loggedIn('racer1@example.com'), loggedIn('racer2@example.com')]);
  const body = { items: [{ productId: fold, qty: 1 }], address, expectedTotal: 8999900 };
  const results = await Promise.all([a('POST', '/orders', body), b('POST', '/orders', body)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await stockOf(FOLD), 0);
  await products.updateOne({ slug: FOLD }, { $set: { stock: 3 } });
});

test('validates the order body', async () => {
  const call = await loggedIn('buyer5@example.com');
  const items = [{ productId: await idOf(BOOK), qty: 1 }];
  const cases = [
    [{ items: [], address, expectedTotal: 0 }, /^items: Your cart is empty$/],
    [{ items: [{ productId: 'x', qty: 1 }], address, expectedTotal: 0 }, /^items\.0\.productId: Invalid product id$/],
    [{ items: [{ ...items[0], qty: 11 }], address, expectedTotal: 0 }, /^items\.0\.qty:/],
    [
      { items, address: { ...address, phone: '12345' }, expectedTotal: 0 },
      /^address\.phone: Enter a 10-digit mobile number$/,
    ],
    [
      { items, address: { ...address, pincode: '012345' }, expectedTotal: 0 },
      /^address\.pincode: Enter a 6-digit PIN code$/,
    ],
    [{ items, address: { ...address, city: ' ' }, expectedTotal: 0 }, /^address\.city: Enter the city$/],
    [{ items, address }, /^expectedTotal:/],
  ];
  for (const [body, error] of cases) {
    const res = await call('POST', '/orders', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, error);
  }
});

test('customers see only their own orders', async () => {
  const owner = await loggedIn('owner@example.com');
  const other = await loggedIn('other@example.com');
  const { body: order } = await placeOrder(owner, [{ productId: await idOf(BOOK), qty: 1 }]);

  assert.equal((await other('GET', `/orders/${order.id}`)).status, 404);
  assert.equal((await other('POST', `/orders/${order.id}/cancel`)).status, 404);
  assert.deepEqual((await other('GET', '/orders')).body, []);
  assert.equal((await owner('GET', '/orders/not-an-id')).status, 400);
  assert.equal((await owner('GET', `/orders/${'0'.repeat(24)}`)).status, 404);
});

test('cancelling a placed order puts the stock back, once', async () => {
  const call = await loggedIn('canceller@example.com');
  const stock = await stockOf(PHONE);
  const { body: order } = await placeOrder(call, [{ productId: await idOf(PHONE), qty: 3 }]);
  assert.equal(await stockOf(PHONE), stock - 3);

  const res = await call('POST', `/orders/${order.id}/cancel`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cancelled');
  assert.ok(res.body.cancelledAt);
  assert.equal(await stockOf(PHONE), stock);

  const again = await call('POST', `/orders/${order.id}/cancel`);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "This order can't be cancelled (it is cancelled)");
  assert.equal(await stockOf(PHONE), stock);
});

test('numbers orders in sequence, and a failed order uses up no number', async () => {
  const call = await loggedIn('numbers@example.com');
  const [book, fold] = await Promise.all([idOf(BOOK), idOf(FOLD)]);
  const [last] = await t.db.collection('orders').find().sort({ number: -1 }).limit(1).toArray();

  const failed = await call('POST', '/orders', { items: [{ productId: fold, qty: 9 }], address, expectedTotal: 0 });
  assert.equal(failed.status, 409);

  const first = await placeOrder(call, [{ productId: book, qty: 1 }]);
  const second = await placeOrder(call, [{ productId: book, qty: 1 }]);
  assert.equal(first.body.number, last.number + 1);
  assert.equal(second.body.number, last.number + 2);

  // Concurrent orders get distinct numbers too (the counter update conflicts and the transaction retries).
  const many = await Promise.all([1, 2, 3].map(() => placeOrder(call, [{ productId: book, qty: 1 }])));
  assert.deepEqual(many.map((r) => r.body.number).sort(), [last.number + 3, last.number + 4, last.number + 5]);
});

test('without Razorpay keys only Cash on Delivery is offered', async () => {
  assert.deepEqual((await t.call('GET', '/payments/options')).body, { cod: true, online: false });
  const call = await loggedIn('nokeys@example.com');
  const res = await call('POST', '/orders', {
    items: [{ productId: await idOf(BOOK), qty: 2 }],
    address,
    expectedTotal: 69800,
    paymentMethod: 'razorpay',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Online payment is not available. Choose Cash on Delivery.');
});
