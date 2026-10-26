import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
let order;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  customer = await register('asha@example.com', 'Asha Rao');
  const p = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const quote = await customer('GET', `/cart?items=${p._id}:1`);
  order = (
    await customer('POST', '/orders', {
      items: [{ productId: p._id.toString(), qty: 1 }],
      address: {
        name: 'Asha Rao',
        phone: '9876543210',
        line1: '12 MG Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
      },
      expectedTotal: quote.body.total,
    })
  ).body;
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}
const addNote = (body, who = admin, id = order.id) => who('POST', `/admin/orders/${id}/notes`, body);
const SECRET = 'Customer called: deliver after 6 pm, gate code 4471';

test('admins add notes, with who wrote them, and see them in the order and the list', async () => {
  const res = await addNote({ text: `  ${SECRET}  ` });
  assert.equal(res.status, 201);
  const [note] = res.body.notes;
  assert.equal(note.text, SECRET);
  assert.equal(note.onSlip, false);
  assert.equal(note.by.name, 'Store Admin');
  assert.ok(note.at);
  const second = await addNote({ text: 'Fragile: wrap twice', onSlip: true });
  assert.deepEqual(
    second.body.notes.map((n) => [n.text, n.onSlip]),
    [
      [SECRET, false],
      ['Fragile: wrap twice', true],
    ],
  );
  assert.equal((await admin('GET', `/admin/orders/${order.id}`)).body.notes.length, 2);
  const listed = (await admin('GET', '/admin/orders')).body.items.find((o) => o.id === order.id);
  assert.equal(listed.notes.length, 2);
  assert.equal((await admin('GET', '/admin/activity?area=orders')).body.items[0].action, 'Added a note to');
});

test('customers never see notes: not in their order, their list, or their emails', async () => {
  const mine = await customer('GET', `/orders/${order.id}`);
  assert.equal(mine.status, 200);
  assert.equal('notes' in mine.body, false);
  assert.ok(!JSON.stringify(mine.body).includes('gate code'));
  assert.ok(!JSON.stringify((await customer('GET', '/orders')).body).includes('gate code'));

  await admin('POST', `/admin/orders/${order.id}/status`, { status: 'shipped' });
  const mails = t.mail.sent.filter((m) => m.to.email === 'asha@example.com');
  assert.ok(mails.some((m) => / has shipped$/.test(m.subject)));
  assert.ok(mails.every((m) => !m.text.includes('gate code') && !m.html.includes('gate code')));

  assert.equal((await addNote({ text: 'hi' }, customer)).status, 403);
  assert.equal((await addNote({ text: 'hi' }, t.call)).status, 401);
});

test('notes are checked, deleted by any admin, and capped per order', async () => {
  assert.match((await addNote({ text: '   ' })).body.error, /Write the note/);
  assert.match((await addNote({ text: 'x'.repeat(1001) })).body.error, /At most 1000/);
  assert.equal((await addNote({ text: 'hi' }, admin, '0123456789abcdef01234567')).status, 404);

  const { notes } = (await admin('GET', `/admin/orders/${order.id}`)).body;
  const del = await admin('DELETE', `/admin/orders/${order.id}/notes/${notes[0].id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(
    del.body.notes.map((n) => n.text),
    ['Fragile: wrap twice'],
  );
  assert.equal((await admin('DELETE', `/admin/orders/${order.id}/notes/${notes[0].id}`)).status, 404);
  assert.equal((await customer('DELETE', `/admin/orders/${order.id}/notes/${notes[1].id}`)).status, 403);
  const log = (await admin('GET', '/admin/activity?area=orders')).body.items[0];
  assert.deepEqual([log.action, log.changes[0].from], ['Deleted a note from', SECRET]);

  const many = Array.from({ length: 99 }, (_, i) => ({
    _id: new ObjectId(),
    text: `n${i}`,
    onSlip: false,
    at: new Date(),
  }));
  await t.db.collection('orders').updateOne({ _id: new ObjectId(order.id) }, { $push: { notes: { $each: many } } });
  assert.match((await addNote({ text: 'one too many' })).body.error, /at most 100 notes/);
});
