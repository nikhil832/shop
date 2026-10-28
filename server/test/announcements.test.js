import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
let packer;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  customer = await register('customer@example.com', 'Asha Rao');
  packer = await register('packer@example.com', 'Pooja Packer');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  await t.db.collection('users').updateOne({ email: 'packer@example.com' }, { $set: { role: 'packer' } });
});
after(() => t.stop());
beforeEach(() => t.db.collection('announcements').deleteMany({}));

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const HOUR = 3_600_000;
const at = (hours) => new Date(Date.now() + hours * HOUR).toISOString();
const shown = async () => (await t.call('GET', '/announcement')).body.announcement;
const create = (body) => admin('POST', '/admin/announcements', { startsAt: at(0), endsAt: at(24), ...body });

test('a message shows to every visitor between its start and end, and only then', async () => {
  assert.equal(await shown(), null);
  const later = await create({ text: 'Orders after 25 Oct ship after Diwali', startsAt: at(2) });
  assert.equal(later.status, 201, JSON.stringify(later.body));
  assert.equal(later.body.status, 'upcoming');
  assert.equal(await shown(), null);

  // A start in the past is now.
  const now = await create({ text: 'Free delivery this week', link: '/search?q=diwali', startsAt: at(-5) });
  assert.equal(now.body.status, 'showing');
  assert.ok(new Date(now.body.startsAt) >= new Date(Date.now() - 60_000));
  const bar = await shown();
  assert.deepEqual([bar.id, bar.text, bar.link], [now.body.id, 'Free delivery this week', '/search?q=diwali']);

  // When two are on, the one that started last shows.
  await t.db
    .collection('announcements')
    .updateOne({ text: 'Orders after 25 Oct ship after Diwali' }, { $set: { startsAt: new Date() } });
  assert.equal((await shown()).text, 'Orders after 25 Oct ship after Diwali');
  const list = (await admin('GET', '/admin/announcements')).body.items;
  assert.deepEqual(
    list.map((a) => [a.text, a.status, a.shown]),
    [
      ['Orders after 25 Oct ship after Diwali', 'showing', true],
      ['Free delivery this week', 'showing', false],
    ],
  );

  // Past its end, it's gone by itself.
  await t.db.collection('announcements').updateMany({}, { $set: { endsAt: new Date(Date.now() - 1000) } });
  assert.equal(await shown(), null);
});

test('messages and links are checked', async () => {
  for (const [body, error] of [
    [{ text: 'Hi' }, 'Write the message'],
    [{ text: 'x'.repeat(161) }, 'At most 160 characters'],
    [{ text: 'Big sale on now', link: 'https://elsewhere.example.com' }, 'A page of the store'],
    [{ text: 'Big sale on now', link: '//elsewhere.example.com' }, 'A page of the store'],
    [{ text: 'Big sale on now', link: 'javascript:alert(1)' }, 'A page of the store'],
    [{ text: 'Big sale on now', endsAt: at(-1) }, 'The end must be after the start'],
    [{ text: 'Big sale on now', startsAt: at(-3), endsAt: at(-1) }, 'over already'],
    [{ text: 'Big sale on now', endsAt: at(24 * 91) }, 'At most 90 days'],
    [{ text: 'Big sale on now', startsAt: 'soon' }, 'Enter a date and time'],
  ]) {
    const res = await create(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error.includes(error), `${res.body.error} / ${error}`);
  }
  // An empty link is no link.
  assert.equal((await create({ text: 'Big sale on now', link: '' })).body.link, null);
});

test('admins edit one, take it down early or call it off; ended ones stay listed and are logged', async () => {
  const live = (await create({ text: 'Delivery slower this week' })).body;
  const edited = await admin('PATCH', `/admin/announcements/${live.id}`, {
    text: 'Delivery slower until Monday',
    link: '/help',
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await shown()).text, 'Delivery slower until Monday');
  assert.equal((await admin('PATCH', `/admin/announcements/${live.id}`, { endsAt: at(-1) })).status, 400);

  assert.equal((await admin('POST', `/admin/announcements/${live.id}/end`)).body.status, 'ended');
  assert.equal(await shown(), null);
  assert.equal((await admin('POST', `/admin/announcements/${live.id}/end`)).status, 409);
  assert.equal((await admin('PATCH', `/admin/announcements/${live.id}`, { text: 'Back again soon' })).status, 409);

  const upcoming = (await create({ text: 'Diwali sale from Friday', startsAt: at(48), endsAt: at(96) })).body;
  const calledOff = await admin('POST', `/admin/announcements/${upcoming.id}/end`);
  assert.equal(calledOff.body.status, 'ended');
  assert.equal((await admin('GET', '/admin/announcements')).body.items.length, 2);
  assert.equal((await admin('POST', '/admin/announcements/000000000000000000000000/end')).status, 404);

  const log = await t.db.collection('activity').find({ area: 'announcements' }).sort({ at: 1 }).toArray();
  assert.deepEqual(
    log.slice(-5).map((e) => e.action),
    [
      'Scheduled announcement',
      'Changed announcement',
      'Took down announcement',
      'Scheduled announcement',
      'Called off announcement',
    ],
  );
  assert.deepEqual(
    log.at(-4).changes.map((c) => c.field),
    ['Message', 'Link'],
  );
});

test('only admins manage them; anyone can read the one showing', async () => {
  assert.equal((await t.call('GET', '/admin/announcements')).status, 401);
  assert.equal((await customer('GET', '/admin/announcements')).status, 403);
  assert.equal((await packer('POST', '/admin/announcements', { text: 'Packed and ready' })).status, 403);
  assert.equal((await customer('GET', '/announcement')).status, 200);
});
