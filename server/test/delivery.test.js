import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { statesForPin } from '../src/pinStates.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

async function register(email) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name: 'Asha Rao', email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

const IST = 330 * 60_000;
const istDate = (n) => new Date(Date.now() + IST + n * 86_400_000).toISOString().slice(0, 10);
const check = (pin) => t.call('GET', `/delivery?pincode=${pin}`);

test('with nothing set up, every PIN is delivered in 3–7 days, with India-time dates', async () => {
  const res = await check('560001');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    pincode: '560001',
    deliverable: true,
    minDays: 3,
    maxDays: 7,
    area: null,
    extraCharge: 0,
    from: istDate(3),
    to: istDate(7),
  });
  for (const pin of ['56000', '060001', 'abcdef', '']) assert.equal((await check(pin)).status, 400, pin);
});

test('areas by PIN prefix: the longest match wins; everywhere else can be switched off', async () => {
  const add = (body) => admin('POST', '/admin/delivery/zones', body);
  assert.equal((await add({ prefix: '56', name: 'Karnataka', deliverable: true, minDays: 2, maxDays: 4 })).status, 201);
  const blr = await add({ prefix: '560', name: 'Bengaluru', deliverable: true, minDays: 1, maxDays: 2 });
  assert.equal(blr.status, 201);
  assert.equal((await add({ prefix: '79', name: 'North East', deliverable: false })).status, 201);
  // One area per prefix; prefixes are 1–6 digits not starting with 0; the days must make sense.
  assert.equal((await add({ prefix: '560', deliverable: true, minDays: 1, maxDays: 1 })).status, 409);
  for (const body of [
    { prefix: '0', deliverable: true, minDays: 1, maxDays: 2 },
    { prefix: '1234567', deliverable: true, minDays: 1, maxDays: 2 },
    { prefix: '40', deliverable: true, minDays: 5, maxDays: 2 },
    { prefix: '40', deliverable: true, minDays: 1, maxDays: 31 },
  ]) {
    assert.equal((await add(body)).status, 400, JSON.stringify(body));
  }

  assert.deepEqual(
    [(await check('560001')).body, (await check('562110')).body, (await check('795001')).body].map((b) => [
      b.deliverable,
      b.minDays,
      b.maxDays,
      b.area,
    ]),
    [
      [true, 1, 2, 'Bengaluru'],
      [true, 2, 4, 'Karnataka'],
      [false, 0, 0, 'North East'],
    ],
  );
  assert.equal((await check('795001')).body.from, undefined);

  // Everywhere else off: only the areas are delivered to.
  const off = await admin('PUT', '/admin/delivery/everywhere-else', { deliverable: false });
  assert.equal(off.status, 200);
  assert.equal((await check('110001')).body.deliverable, false);
  assert.equal((await check('560001')).body.deliverable, true);
  const list = (await admin('GET', '/admin/delivery')).body;
  assert.deepEqual(list.everywhereElse, { deliverable: false, minDays: 0, maxDays: 0, extraCharge: 0 });
  assert.deepEqual(
    list.zones.map((z) => z.prefix),
    ['56', '560', '79'],
  );

  // Edit and delete.
  const edited = await admin('PUT', `/admin/delivery/zones/${blr.body.id}`, {
    prefix: '560',
    name: 'Bengaluru city',
    deliverable: true,
    minDays: 0,
    maxDays: 1,
  });
  assert.equal(edited.body.name, 'Bengaluru city');
  assert.equal((await check('560001')).body.from, istDate(0));
  assert.equal((await admin('DELETE', `/admin/delivery/zones/${blr.body.id}`)).status, 204);
  assert.equal((await check('560001')).body.area, 'Karnataka');
  await admin('PUT', '/admin/delivery/everywhere-else', { deliverable: true, minDays: 3, maxDays: 7 });
});

test("checkout refuses an address the store doesn't deliver to, and changes nothing", async () => {
  const call = await register('buyer@example.com');
  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const quote = await call('GET', `/cart?items=${book._id}:1`);
  const order = (pincode) =>
    call('POST', '/orders', {
      items: [{ productId: book._id.toString(), qty: 1 }],
      address: {
        name: 'Asha Rao',
        phone: '9876543210',
        line1: '1 Hill Road',
        city: 'Aizawl',
        // A state the PIN code is in (addresses are checked against it).
        state: statesForPin(pincode)[0],
        pincode,
      },
      expectedTotal: quote.body.total,
    });
  const refused = await order('796001');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "Sorry, we don't deliver to 796001 yet.");
  assert.equal((await t.db.collection('products').findOne({ _id: book._id })).stock, book.stock);
  assert.equal((await order('400001')).status, 201);
});

test('only admins manage delivery areas', async () => {
  const customer = await register('customer@example.com');
  assert.equal((await t.call('GET', '/admin/delivery')).status, 401);
  assert.equal((await customer('POST', '/admin/delivery/zones', { prefix: '1', deliverable: false })).status, 403);
  assert.equal((await customer('PUT', '/admin/delivery/everywhere-else', { deliverable: false })).status, 403);
});
