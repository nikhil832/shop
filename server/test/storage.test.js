import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { checkStorage, storageUse } from '../src/storage.js';

let t;
let admin;
const MB = 1024 * 1024;
before(async () => {
  t = await startTestServer();
  t.ctx.config.mail.adminEmails = ['owner@example.com'];
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

const warnings = () => t.mail.sent.filter((m) => /^Database storage is \d+% full$/.test(m.subject));
// Sets the limit so the database is about `percent` full.
async function fillTo(percent) {
  const { usedBytes } = await storageUse(t.db, t.ctx.config);
  t.ctx.config.storageLimitMb = usedBytes / (percent / 100) / MB;
}

test('the dashboard shows how much of the limit is used, and what uses it', async () => {
  await admin(
    'POST',
    '/admin/images',
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200_000)]),
    'image/jpeg',
  );
  const { storage } = (await admin('GET', '/admin/dashboard')).body;
  assert.equal(storage.limitBytes, 512 * MB);
  assert.ok(storage.usedBytes > 200_000);
  assert.equal(storage.percent, Math.round((storage.usedBytes / storage.limitBytes) * 1000) / 10);
  assert.equal(storage.collections[0].label, 'Photos'); // the 200 KB upload is the biggest
  const sizes = storage.collections.map((c) => c.bytes);
  assert.deepEqual(
    sizes,
    [...sizes].sort((a, b) => b - a),
  );
  assert.ok(storage.collections.some((c) => c.label === 'Products'));
});

test('admins are emailed past 80% and 95%, reminded weekly, and reset once below', async () => {
  const now = Date.now();
  const at = (days) => new Date(now + days * 86_400_000);

  t.ctx.config.storageLimitMb = 512;
  assert.equal(await checkStorage(t.ctx, at(0)), 0);
  await fillTo(85);
  assert.equal(await checkStorage(t.ctx, at(0)), 80);
  const [mail] = warnings();
  assert.equal(mail.to.email, 'owner@example.com');
  assert.match(mail.subject, /^Database storage is 8\d% full$/);
  assert.match(mail.text, /Biggest: Photos [\d.]+ (KB|MB)/);
  assert.equal(await checkStorage(t.ctx, at(1)), 0); // told already this week

  await fillTo(97);
  assert.equal(await checkStorage(t.ctx, at(1)), 95); // a higher level: at once
  assert.equal(await checkStorage(t.ctx, at(3)), 0);
  assert.equal(await checkStorage(t.ctx, at(9)), 95); // a week on, still full: a reminder
  assert.equal(warnings().length, 3);

  t.ctx.config.storageLimitMb = 512; // room again
  assert.equal(await checkStorage(t.ctx, at(10)), 0);
  await fillTo(85);
  assert.equal(await checkStorage(t.ctx, at(10)), 80); // full again: a new warning
  assert.equal(warnings().length, 4);
  t.ctx.config.storageLimitMb = 512;
});

test('a database that refuses size statistics shows what it can, and never breaks the dashboard', async () => {
  const realCommand = t.db.command.bind(t.db);
  // Without per-collection figures ($collStats refused): the total, no breakdown.
  const proto = Object.getPrototypeOf(t.db.collection('orders'));
  const aggregate = proto.aggregate;
  proto.aggregate = function (pipeline, ...rest) {
    if (pipeline?.[0]?.$collStats) return { toArray: () => Promise.reject(new Error('not allowed on this tier')) };
    return aggregate.call(this, pipeline, ...rest);
  };
  try {
    const use = await storageUse(t.db, t.ctx.config);
    assert.ok(use.usedBytes > 0);
    assert.deepEqual(use.collections, []);
    // Without any figures: null, and the dashboard still loads.
    t.db.command = (cmd, ...rest) =>
      cmd.dbStats ? Promise.reject(new Error('not allowed on this tier')) : realCommand(cmd, ...rest);
    const res = await admin('GET', '/admin/dashboard');
    assert.equal(res.status, 200);
    assert.equal(res.body.storage, null);
    assert.equal(await checkStorage(t.ctx), 0);
  } finally {
    proto.aggregate = aggregate;
    t.db.command = realCommand;
  }
});
