import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { INDIAN_STATES } from '../src/gst.js';
import { PIN_PREFIXES, statesForPin } from '../src/pinStates.js';
import { startTestServer } from './helpers.js';

let t;
let customer;
before(async () => {
  t = await startTestServer();
  customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
});
after(() => t.stop());

test('the client and server tables are the same file, naming only real states, without overlaps', async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  assert.equal(await read('../../client/src/pinStates.js'), await read('../src/pinStates.js'));
  const names = new Set(INDIAN_STATES.map((s) => s.name));
  for (const [from, to, states] of PIN_PREFIXES) {
    assert.ok(from <= to, `${from}–${to}`);
    for (const s of states) assert.ok(names.has(s), s);
  }
  for (let i = 1; i < PIN_PREFIXES.length; i++) assert.ok(PIN_PREFIXES[i][0] > PIN_PREFIXES[i - 1][1]);
});

test('a PIN code gives the states it can be in', () => {
  assert.deepEqual(statesForPin('560001'), ['Karnataka']);
  assert.deepEqual(statesForPin('403001'), ['Goa']);
  assert.deepEqual(statesForPin('110001'), ['Delhi']);
  assert.deepEqual(statesForPin('682001'), ['Kerala', 'Lakshadweep']);
  assert.ok(statesForPin('160055').includes('Punjab'));
  assert.equal(statesForPin('999999'), null); // Army Postal Service: not checked
  assert.equal(statesForPin('12345'), null);
});

test('an address whose state its PIN code is not in is refused, wherever addresses are taken', async () => {
  const address = (state, pincode) => ({ name: 'Asha', phone: '9876543210', line1: 'x', city: 'y', state, pincode });
  const wrong = await customer('POST', '/account/addresses', { address: address('Kerala', '560001') });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'address.state: PIN code 560001 is in Karnataka, not Kerala');
  // Typed state names are matched after they're tidied ("karnataka" → "Karnataka").
  assert.equal((await customer('POST', '/account/addresses', { address: address('karnataka', '560001') })).status, 201);
  // Either state of a shared prefix, and unknown prefixes, pass.
  assert.equal(
    (await customer('POST', '/account/addresses', { address: address('Lakshadweep', '682555') })).status,
    201,
  );
  assert.equal((await customer('POST', '/account/addresses', { address: address('Delhi', '999001') })).status, 201);

  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const order = await customer('POST', '/orders', {
    items: [{ productId: book._id.toString(), qty: 1 }],
    address: address('Tamil Nadu', '560001'),
    expectedTotal: 38900,
  });
  assert.equal(order.status, 400);
  assert.match(order.body.error, /PIN code 560001 is in Karnataka, not Tamil Nadu/);
});
