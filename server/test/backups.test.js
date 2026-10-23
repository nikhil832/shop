import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Binary, ObjectId } from 'mongodb';
import { backupDatabase, NOT_BACKED_UP, readManifest, restoreDatabase } from '../src/backups.js';
import { startTestServer } from './helpers.js';

let t;
let parent;
before(async () => {
  t = await startTestServer();
  parent = await mkdtemp(join(tmpdir(), 'bazaar-backups-'));
  // A customer (with a session and a login attempt), an uploaded photo and an order, besides the sample catalog.
  const call = t.browser();
  assert.equal(
    (await call('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' }))
      .status,
    201,
  );
  await t.db
    .collection('loginAttempts')
    .insertOne({ key: 'x', at: new Date(), expiresAt: new Date(Date.now() + 60_000) });
  await t.db.collection('images').insertOne({
    data: new Binary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])),
    contentType: 'image/png',
    size: 7,
    createdAt: new Date('2026-10-01T10:00:00Z'),
  });
  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const quote = await call('GET', `/cart?items=${book._id}:1`);
  const order = await call('POST', '/orders', {
    items: [{ productId: book._id.toString(), qty: 1 }],
    address: {
      name: 'Asha Rao',
      phone: '9876543210',
      line1: '12 MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    },
    expectedTotal: quote.body.total,
  });
  assert.equal(order.status, 201);
});
after(async () => {
  await t.stop();
  await rm(parent, { recursive: true, force: true });
});

const all = (name) => t.db.collection(name).find().sort({ _id: 1 }).toArray();

test('a backup saves every collection but the short-lived security ones, readable by its owner only', async () => {
  const { dir, collections } = await backupDatabase(t.db, parent, { now: new Date(2026, 9, 23, 14, 5) });
  assert.equal(dir, join(parent, `${t.db.databaseName}-2026-10-23-1405`));
  for (const name of ['products', 'categories', 'users', 'orders', 'images', 'counters']) {
    assert.ok(name in collections, name);
  }
  assert.equal(collections.products, 38);
  for (const name of NOT_BACKED_UP) assert.ok(!(name in collections), name);
  assert.equal(await t.db.collection('sessions').countDocuments(), 1); // it existed, and was left out

  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, ['manifest.json', ...Object.keys(collections).map((n) => `${n}.jsonl`)].sort());
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'users.jsonl'))).mode & 0o777, 0o600);
  const manifest = await readManifest(dir);
  assert.equal(manifest.database, t.db.databaseName);
  assert.deepEqual(manifest.collections, collections);
  // Types are kept: an id is written as an ObjectId, not a plain string.
  const firstUser = (await readFile(join(dir, 'users.jsonl'), 'utf8')).split('\n')[0];
  assert.match(firstUser, /"_id":\{"\$oid":"[0-9a-f]{24}"\}/);

  // A second backup in the same minute doesn't overwrite the first.
  await assert.rejects(backupDatabase(t.db, parent, { now: new Date(2026, 9, 23, 14, 5) }), /EEXIST/);
});

test('restoring brings back exactly what was saved, and leaves other collections alone', async () => {
  const before = Object.fromEntries(
    await Promise.all(['products', 'users', 'orders', 'images', 'counters'].map(async (n) => [n, await all(n)])),
  );
  const { dir } = await backupDatabase(t.db, parent, { now: new Date(2026, 9, 23, 15, 0) });

  // Things go wrong: products edited and deleted, an order and a photo lost, a stray product added.
  await t.db.collection('products').updateMany({}, { $set: { price: 1 } });
  await t.db.collection('products').deleteMany({ 'rating.count': { $gt: 1000 } });
  await t.db.collection('orders').deleteMany({});
  await t.db.collection('images').deleteMany({});
  await t.db.collection('products').insertOne({ _id: new ObjectId(), slug: 'stray', title: 'Stray' });
  const sessions = await t.db.collection('sessions').countDocuments();

  const restored = await restoreDatabase(t.db, dir);
  assert.equal(restored.products, 38);
  for (const [name, docs] of Object.entries(before)) assert.deepEqual(await all(name), docs, name);
  // The photo's bytes and the dates are the same types as before.
  const [photo] = await all('images');
  assert.ok(photo.data instanceof Binary);
  assert.deepEqual([...photo.data.buffer.subarray(0, photo.data.position)], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  assert.ok(photo.createdAt instanceof Date);
  // Logins aren't in backups, so restoring doesn't touch them.
  assert.equal(await t.db.collection('sessions').countDocuments(), sessions);
  // The store works on the restored data.
  assert.equal((await t.call('GET', '/products?pageSize=1')).body.total, 38);
});

test('restore refuses a folder that is not a backup, or one whose files are short', async () => {
  await assert.rejects(restoreDatabase(t.db, parent), /not a backup folder/);
  const { dir } = await backupDatabase(t.db, parent, { now: new Date(2026, 9, 23, 16, 0) });
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  manifest.collections.categories += 1;
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(restoreDatabase(t.db, dir), /categories: the backup lists 7 documents but has 6/);
});

test('the command line: restore without --yes only describes the backup; a failed connection names no host', async () => {
  const { dir } = await backupDatabase(t.db, parent, { now: new Date(2026, 9, 23, 17, 0) });
  const run = (...args) =>
    spawnSync(process.execPath, ['src/backups.js', ...args], {
      cwd: new URL('..', import.meta.url),
      // A database that isn't there: nothing here may reach a real one.
      env: { PATH: process.env.PATH, MONGODB_URI: 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=500' },
      encoding: 'utf8',
    });

  const dry = run('restore', dir);
  assert.equal(dry.status, 1);
  assert.match(dry.stderr, /This replaces the data in "shop" with the backup of ".+" from 2026-10-23/);
  assert.match(dry.stderr, /products: 38/);
  assert.match(dry.stderr, /Run again with --yes/);
  assert.match(run('restore', parent).stderr, /is not a backup folder/);

  const inRepo = spawnSync(process.execPath, ['src/backups.js', 'backup'], {
    cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH, MONGODB_URI: 'mongodb://127.0.0.1:1/', BACKUP_DIR: 'backups' },
    encoding: 'utf8',
  });
  assert.equal(inRepo.status, 1);
  assert.match(inRepo.stderr, /is inside the repository/);

  const failed = run('backup');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Could not connect to the database \(\w+\)\. Check MONGODB_URI in server\/\.env\./);
  assert.ok(!`${failed.stdout}${failed.stderr}`.includes('127.0.0.1'));
});
