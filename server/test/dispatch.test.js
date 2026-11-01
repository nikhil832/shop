import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { DEFAULTS, dispatchState } from '../src/dispatch.js';

// Ship-today countdown (stage 139).
let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

const ON = { ...DEFAULTS, enabled: true }; // by 14:00, Monday to Saturday
const at = (iso) => new Date(`${iso}+05:30`); // India time
// 2026-11-02 is a Monday.

test('before the cut-off on a working day it ships today; after, the next working day', () => {
  assert.equal(dispatchState(DEFAULTS, null, at('2026-11-02T10:00')), null); // off
  assert.deepEqual(dispatchState(ON, null, at('2026-11-02T10:00')), {
    shipsToday: true,
    cutoffAt: at('2026-11-02T14:00'),
  });
  assert.deepEqual(dispatchState(ON, null, at('2026-11-02T14:00')), {
    shipsToday: false,
    shipsOn: '2026-11-03',
    tomorrow: true,
  });
  // Saturday afternoon: Sunday is off, so Monday.
  assert.deepEqual(dispatchState(ON, null, at('2026-11-07T16:00')), {
    shipsToday: false,
    shipsOn: '2026-11-09',
    tomorrow: false,
  });
  // Sunday morning: not a working day.
  assert.equal(dispatchState(ON, null, at('2026-11-08T09:00')).shipsOn, '2026-11-09');
  // Just after midnight India time (still the day before in UTC) counts as the new day.
  assert.equal(dispatchState(ON, null, at('2026-11-03T00:30')).shipsToday, true);
});

test('a store holiday is not a working day', () => {
  const holiday = { from: '2026-11-02', to: '2026-11-04', takeOrders: true };
  assert.deepEqual(dispatchState(ON, holiday, at('2026-11-02T10:00')), {
    shipsToday: false,
    shipsOn: '2026-11-05',
    tomorrow: false,
  });
  assert.equal(dispatchState(ON, holiday, at('2026-11-01T18:00')).shipsOn, '2026-11-05');
  // No working day ahead at all.
  assert.equal(
    dispatchState({ ...ON, days: [0] }, { from: '2026-11-01', to: '2027-03-01' }, at('2026-11-02T10:00')),
    null,
  );
});

test('admins set it; the settings are checked and logged; the shop reads it', async () => {
  assert.deepEqual((await t.call('GET', '/dispatch')).body, { dispatch: null });
  assert.deepEqual((await admin('GET', '/admin/dispatch')).body, DEFAULTS);
  for (const bad of [
    { ...ON, cutoff: '24:00' },
    { ...ON, cutoff: '2pm' },
    { ...ON, days: [] },
    { ...ON, days: [1, 1] },
    { ...ON, days: [7] },
  ]) {
    assert.equal((await admin('PUT', '/admin/dispatch', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await t.call('PUT', '/admin/dispatch', ON)).status, 401);

  // Every day until a minute before midnight, so it ships today whatever the time of the test.
  const res = await admin('PUT', '/admin/dispatch', { enabled: true, cutoff: '23:59', days: [6, 0, 1, 2, 3, 4, 5] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.days, [0, 1, 2, 3, 4, 5, 6]);
  const shop = (await t.call('GET', '/dispatch')).body.dispatch;
  if (shop.shipsToday) assert.ok(new Date(shop.cutoffAt) > new Date());
  else assert.equal(shop.tomorrow, true); // the test ran in the last minute of the day
  const log = await t.db.collection('activity').findOne({ action: 'Changed the dispatch cut-off' });
  assert.deepEqual(log.changes, [
    { field: 'Countdown', from: 'off', to: 'on, by 23:59 on Sun, Mon, Tue, Wed, Thu, Fri, Sat' },
  ]);
});
