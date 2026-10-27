import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ADDRESSES, migrateAddresses } from '../src/addressBook.js';
import { startTestServer } from './helpers.js';

let t;
before(async () => (t = await startTestServer()));
after(() => t.stop());

const home = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  line2: '',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const office = { ...home, line1: '4th floor, Prestige Tower', line2: 'Near the metro', pincode: '560025' };
const parents = { ...home, name: 'Kamala Rao', line1: '7 Temple Street', city: 'Mysuru', pincode: '570001' };

let n = 0;
async function register() {
  const email = `book${++n}@example.com`;
  const call = t.browser();
  assert.equal(
    (await call('POST', '/auth/register', { name: 'Asha Rao', email, password: 'password123' })).status,
    201,
  );
  call.email = email;
  return call;
}
// The book as { label, line1 } pairs, default first.
const book = (user) => user.addresses.map((a) => [a.label, a.line1]);

async function order(call, address, extra = {}) {
  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const items = [{ productId: book._id.toString(), qty: 1 }];
  const quote = await call('GET', `/cart?items=${items[0].productId}:1`);
  const res = await call('POST', '/orders', { items, address, expectedTotal: quote.body.total, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('customers add, label, edit, remove and choose a default address', async () => {
  const call = await register();
  assert.deepEqual((await call('GET', '/auth/me')).body.user.addresses, []);

  const first = await call('POST', '/account/addresses', { address: home, label: ' Home ' });
  assert.equal(first.status, 201);
  const [saved] = first.body.user.addresses;
  assert.deepEqual(saved, { id: saved.id, label: 'Home', ...home });
  // The first one is the default, which `address` gives too (the delivery check starts from its PIN).
  assert.deepEqual(first.body.user.address, saved);

  await call('POST', '/account/addresses', { address: office, label: 'Office' });
  let user = (await call('POST', '/account/addresses', { address: parents })).body.user;
  assert.deepEqual(book(user), [
    ['Home', home.line1],
    ['Office', office.line1],
    ['', parents.line1],
  ]);

  // Default: moved to the front.
  const [, officeId, parentsId] = user.addresses.map((a) => a.id);
  user = (await call('POST', `/account/addresses/${parentsId}/default`)).body.user;
  assert.deepEqual(book(user)[0], ['', parents.line1]);
  assert.equal(user.address.id, parentsId);

  // Edit keeps the id and the place in the list.
  const edited = await call('PUT', `/account/addresses/${officeId}`, {
    address: { ...office, line1: '5th floor, Prestige Tower' },
    label: 'Work',
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.user.addresses[2], {
    id: officeId,
    label: 'Work',
    ...office,
    line1: '5th floor, Prestige Tower',
  });

  // Removing the default makes the next one the default.
  user = (await call('DELETE', `/account/addresses/${parentsId}`)).body.user;
  assert.deepEqual(book(user), [
    ['Home', home.line1],
    ['Work', '5th floor, Prestige Tower'],
  ]);
});

test('addresses are checked, kept once, and at most ten', async () => {
  const call = await register();
  const bad = await call('POST', '/account/addresses', { address: { ...home, pincode: '012345' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'address.pincode: Enter a 6-digit PIN code');
  const long = await call('POST', '/account/addresses', { address: home, label: 'x'.repeat(31) });
  assert.equal(long.body.error, 'label: At most 30 characters');
  // The state is stored by its proper name, so "karnataka" is the same address.
  await call('POST', '/account/addresses', { address: home });
  const again = await call('POST', '/account/addresses', { address: { ...home, state: 'karnataka' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'This address is already saved');

  for (let i = 2; i <= MAX_ADDRESSES; i++) {
    assert.equal((await call('POST', '/account/addresses', { address: { ...home, line1: `House ${i}` } })).status, 201);
  }
  const full = await call('POST', '/account/addresses', { address: { ...home, line1: 'One more' } });
  assert.equal(full.status, 409);
  assert.equal(full.body.error, 'You can keep up to 10 addresses');

  for (const [method, path] of [
    ['PUT', '/account/addresses/000000000000000000000000'],
    ['DELETE', '/account/addresses/000000000000000000000000'],
    ['POST', '/account/addresses/000000000000000000000000/default'],
  ]) {
    assert.equal((await call(method, path, { address: home })).status, 404, `${method} ${path}`);
  }
  assert.equal((await call('DELETE', '/account/addresses/nope')).status, 400);
});

test("one customer can't touch another's addresses", async () => {
  const owner = await register();
  const id = (await owner('POST', '/account/addresses', { address: home })).body.user.addresses[0].id;
  const other = await register();
  assert.equal((await other('PUT', `/account/addresses/${id}`, { address: office })).status, 404);
  assert.equal((await other('DELETE', `/account/addresses/${id}`)).status, 404);
  assert.equal((await other('POST', `/account/addresses/${id}/default`)).status, 404);
  assert.equal((await owner('GET', '/auth/me')).body.user.addresses[0].line1, home.line1);
});

test('ordering adds a new address to the book unless told not to, and never changes a saved one', async () => {
  const call = await register();
  await order(call, home);
  let user = (await call('GET', '/auth/me')).body.user;
  assert.deepEqual(book(user), [['', home.line1]]);

  // A saved address again: nothing changes. A new one is added at the end; the default stays.
  await order(call, home);
  await order(call, office);
  user = (await call('GET', '/auth/me')).body.user;
  assert.deepEqual(book(user), [
    ['', home.line1],
    ['', office.line1],
  ]);

  // "Save it" unticked: the order goes there, the book stays.
  const sent = await order(call, parents, { saveAddress: false });
  assert.equal(sent.address.line1, parents.line1);
  assert.equal((await call('GET', '/auth/me')).body.user.addresses.length, 2);
});

test('a full book still takes orders to a new address', async () => {
  const call = await register();
  for (let i = 1; i <= MAX_ADDRESSES; i++)
    await call('POST', '/account/addresses', { address: { ...home, line1: `House ${i}` } });
  const placed = await order(call, office);
  assert.equal(placed.address.line1, office.line1);
  assert.equal((await call('GET', '/auth/me')).body.user.addresses.length, MAX_ADDRESSES);
});

test('the one address saved before the address book becomes the first entry', async () => {
  const call = await register();
  const users = t.db.collection('users');
  await users.updateOne({ email: call.email }, { $set: { address: home }, $unset: { addresses: '' } });
  assert.ok((await migrateAddresses(t.db)) >= 1);
  assert.equal(await migrateAddresses(t.db), 0); // done once
  const doc = await users.findOne({ email: call.email });
  assert.equal(doc.address, undefined);
  const user = (await call('GET', '/auth/me')).body.user;
  assert.deepEqual(book(user), [['', home.line1]]);
  assert.equal(user.address.pincode, home.pincode);
});
