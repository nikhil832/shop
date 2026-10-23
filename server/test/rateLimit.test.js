import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { takeHourlySlot } from '../src/rateLimit.js';
import { startTestServer } from './helpers.js';

let t;
before(async () => (t = await startTestServer()));
after(() => t.stop());

test('an hourly limit lets exactly that many through, even all at once', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => takeHourlySlot(t.db, 'burst', 3)));
  assert.equal(results.filter(Boolean).length, 3);
  assert.equal(await takeHourlySlot(t.db, 'burst', 3), false);
  // Another key has its own allowance.
  assert.equal(await takeHourlySlot(t.db, 'other', 3), true);
});

test('uses older than an hour no longer count', async () => {
  for (let i = 0; i < 3; i++) assert.equal(await takeHourlySlot(t.db, 'aged', 3), true);
  assert.equal(await takeHourlySlot(t.db, 'aged', 3), false);
  await t.db
    .collection('rateLimits')
    .updateOne({ _id: 'aged' }, { $set: { 'uses.0.at': new Date(Date.now() - 61 * 60_000) } });
  assert.equal(await takeHourlySlot(t.db, 'aged', 3), true);
  assert.equal(await takeHourlySlot(t.db, 'aged', 3), false);
});
