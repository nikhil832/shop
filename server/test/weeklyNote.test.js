import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { factLines, sendWeeklyNote, weekFigures, weekStart } from '../src/weeklyNote.js';
import { startTestServer } from './helpers.js';

// The note is written by a stand-in Claude API (t.claude): nothing here calls the real one or costs money.
let t;
let off; // a server without an API key
let admin;
let book;
before(async () => {
  [t, off] = await Promise.all([startTestServer({ ai: 'claude-haiku-5-5' }), startTestServer()]);
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Owner', email: 'owner@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
});
after(() => Promise.all([t.stop(), off.stop()]));

// India time is UTC+5:30: Monday 26 October 2026, 9:00 there is 03:30 UTC.
const MONDAY_9AM = new Date('2026-10-26T03:30:00Z');
const at = (iso) => new Date(iso);
const order = (createdAt, total, status = 'placed', qty = 1) => ({
  userId: book._id,
  status,
  createdAt,
  total,
  discount: 0,
  items: [{ productId: book._id, title: book.title, price: total, qty }],
});
const notes = () => t.mail.sent.filter((m) => m.subject.startsWith('Your week at Bazaar'));

test('weeks run Monday to Sunday in India time', () => {
  // Sunday 23:59 India time is still the week that began on Monday the 19th.
  assert.equal(weekStart(at('2026-10-25T18:29:00Z')).toISOString(), '2026-10-18T18:30:00.000Z');
  assert.equal(weekStart(at('2026-10-25T18:30:00Z')).toISOString(), '2026-10-25T18:30:00.000Z');
  assert.equal(weekStart(MONDAY_9AM).toISOString(), '2026-10-25T18:30:00.000Z');
});

test("last week's figures, compared with the week before, written for people", async () => {
  await t.db.collection('orders').insertMany([
    order(at('2026-10-19T00:00:00Z'), 50000, 'delivered', 2), // Monday 19th, 5:30 am India time
    order(at('2026-10-25T18:00:00Z'), 30000), // Sunday 25th, 11:30 pm India time
    order(at('2026-10-20T10:00:00Z'), 99900, 'cancelled'),
    order(at('2026-10-14T10:00:00Z'), 40000, 'shipped'), // the week before
    order(at('2026-10-26T10:00:00Z'), 12300), // this week: not in the note
  ]);
  const f = await weekFigures(t.db, MONDAY_9AM);
  assert.deepEqual(
    [f.from, f.to, f.revenue, f.orders, f.itemsSold, f.cancelled],
    ['2026-10-19', '2026-10-25', 80000, 2, 3, 1],
  );
  assert.deepEqual(f.previous, { revenue: 40000, orders: 1 });
  assert.deepEqual(f.bestSellers, [{ title: book.title, qty: 3, sales: 130000 }]);
  assert.equal(f.toShip, 2); // placed orders now, whatever their week
  assert.equal(f.lowStockCount > 0, true); // the sample catalog has sold-out products

  const lines = Object.fromEntries(factLines(f));
  assert.equal(lines.Sales, '₹800 (week before: ₹400, up 100%)');
  assert.equal(lines.Orders, '2 (week before: 1, up 100%)');
  assert.equal(lines['Best sellers'], `${book.title} × 3 (₹1,300)`);
  assert.match(lines['Low stock now'], /sold out/);
});

test('sent once a week to every admin from Monday 9 am, with the figures below the note', async () => {
  assert.equal(await sendWeeklyNote(t.ctx, at('2026-10-26T03:29:00Z')), 'early');
  assert.equal(await sendWeeklyNote(t.ctx, MONDAY_9AM), 'sent');
  assert.equal(await sendWeeklyNote(t.ctx, at('2026-10-27T05:00:00Z')), 'done'); // later that week
  const [note, ...more] = notes();
  assert.equal(more.length, 0);
  assert.equal(note.to.email, 'owner@example.com');
  assert.equal(note.subject, 'Your week at Bazaar: ₹800 from 2 orders (19 Oct to 25 Oct)');
  assert.match(note.text, /^Last week brought in ₹800 \(week before: ₹400, up 100%\)\.\n\nTwo orders are waiting/);
  assert.match(note.text, /Written by Claude from the figures below/);
  assert.match(note.text, /^Cancelled orders: 1$/m);
  assert.match(note.html, /Open the dashboard/);

  // What Claude was given: the week and the same lines, at low effort.
  const { body } = t.claude.calls.at(-1);
  assert.equal(body.output_config.effort, 'low');
  assert.match(body.system, /Never calculate new numbers/);
  assert.match(body.messages[0].content[0].text, /^Week: 2026-10-19 to 2026-10-25\nSales: ₹800/);
  // Haiku has no server-side fallback, so none is asked for.
  assert.equal(body.fallbacks, undefined);

  // The next Monday sends again.
  assert.equal(await sendWeeklyNote(t.ctx, at('2026-11-02T04:00:00Z')), 'sent');
  assert.equal(notes().length, 2);
});

test('if Claude fails, the figures go alone; without an API key or switched off, nothing goes', async () => {
  t.claude.failNext(2); // the SDK retries once
  assert.equal(await sendWeeklyNote(t.ctx, at('2026-11-09T04:00:00Z')), 'sent');
  const note = notes().at(-1);
  assert.match(note.text, /^This week's note couldn't be written, so here are the figures on their own\./);
  assert.doesNotMatch(note.text, /Written by Claude/);

  assert.equal(await sendWeeklyNote(off.ctx, at('2026-11-16T04:00:00Z')), 'off');
  assert.equal(await sendWeeklyNote({ ...t.ctx, ai: null }, at('2026-11-16T04:00:00Z')), 'off');

  assert.equal((await admin('PUT', '/admin/weekly-note', { enabled: false })).status, 200);
  assert.equal(await sendWeeklyNote(t.ctx, at('2026-11-16T04:00:00Z')), 'off');
  // Switched back on in the same week: that week's still comes.
  await admin('PUT', '/admin/weekly-note', { enabled: true });
  assert.equal(await sendWeeklyNote(t.ctx, at('2026-11-16T05:00:00Z')), 'sent');
});

test('admins switch it on and off (logged once) and can send themselves one now', async () => {
  const customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
  assert.equal((await t.call('GET', '/admin/weekly-note')).status, 401);
  assert.equal((await customer('PUT', '/admin/weekly-note', { enabled: false })).status, 403);
  assert.equal((await customer('POST', '/admin/weekly-note/send')).status, 403);
  assert.equal((await admin('PUT', '/admin/weekly-note', {})).status, 400);

  assert.deepEqual((await admin('GET', '/admin/weekly-note')).body, { available: true, enabled: true });
  await admin('PUT', '/admin/weekly-note', { enabled: false });
  await admin('PUT', '/admin/weekly-note', { enabled: false });
  assert.deepEqual((await admin('GET', '/admin/weekly-note')).body, { available: true, enabled: false });
  const logged = (await admin('GET', '/admin/activity?area=settings')).body.items.filter((e) =>
    /weekly note/.test(e.action),
  );
  assert.deepEqual(
    logged.map((e) => e.action),
    ['Switched off the weekly note', 'Switched on the weekly note', 'Switched off the weekly note'],
  );

  // "Send me one now" goes to this admin only, even while switched off, and doesn't count as the week's.
  const before = notes().length;
  assert.equal((await admin('POST', '/admin/weekly-note/send')).status, 204);
  assert.equal(notes().length, before + 1);
  assert.equal(notes().at(-1).to.email, 'owner@example.com');
  t.mail.failNext();
  assert.equal((await admin('POST', '/admin/weekly-note/send')).status, 502);

  const offAdmin = off.browser();
  await offAdmin('POST', '/auth/register', { name: 'Off Admin', email: 'off@example.com', password: 'password123' });
  await off.db.collection('users').updateOne({ email: 'off@example.com' }, { $set: { role: 'admin' } });
  assert.deepEqual((await offAdmin('GET', '/admin/weekly-note')).body, { available: false, enabled: true });
  assert.equal((await offAdmin('POST', '/admin/weekly-note/send')).status, 503);
});
