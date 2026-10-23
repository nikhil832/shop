// Backups of the store's database, for Atlas's free tier, which keeps none.
//   npm run backup                          saves every collection to ~/Bazaar-backups/<database>-<date-time>/
//   npm run restore -- <folder> --yes       replaces the database's data with a backup (after backing up what's there)
// A backup is one file per collection, one document per line in canonical Extended JSON (so ObjectIds, dates and
// uploaded photos come back exactly), plus manifest.json. Files are readable by your user only: they hold customers'
// addresses and password hashes. BACKUP_DIR changes where they go; they never belong in the (public) repository.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BSON } from 'mongodb';
import { loadConfig } from './config.js';
import { connectDb } from './db.js';

const { EJSON } = BSON;
const FORMAT = 1;
// Short-lived security records: logins, login attempts and one-time links. Not worth keeping, and better not copied.
export const NOT_BACKED_UP = ['sessions', 'loginAttempts', 'passwordResets', 'emailChanges'];
const BATCH = 500;

export const defaultBackupDir = () => process.env.BACKUP_DIR?.trim() || join(homedir(), 'Bazaar-backups');

// "2026-10-23-1405" in the computer's own time, for folder names that sort by date.
function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

// Saves every collection (except NOT_BACKED_UP) into a new folder under `parent`. Returns { dir, collections }, where
// collections maps each name to its number of documents.
export async function backupDatabase(db, parent, { now = new Date(), name = db.databaseName } = {}) {
  const dir = join(parent, `${name}-${stamp(now)}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  // Not recursive: a folder from the same minute is never overwritten.
  await mkdir(dir, { mode: 0o700 });
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !NOT_BACKED_UP.includes(n) && !n.startsWith('system.'))
    .sort();
  const collections = {};
  for (const collection of names) {
    const out = createWriteStream(join(dir, `${collection}.jsonl`), { mode: 0o600 });
    let count = 0;
    for await (const doc of db.collection(collection).find().sort({ _id: 1 })) {
      if (!out.write(`${EJSON.stringify(doc, { relaxed: false })}\n`)) {
        await new Promise((done) => out.once('drain', done));
      }
      count++;
    }
    out.end();
    await finished(out);
    collections[collection] = count;
  }
  const manifest = { format: FORMAT, database: db.databaseName, createdAt: now.toISOString(), collections };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { dir, collections };
}

// Reads a backup's manifest, refusing a folder that isn't one.
export async function readManifest(dir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw new Error(`${dir} is not a backup folder (no readable manifest.json)`);
  }
  if (manifest.format !== FORMAT || typeof manifest.collections !== 'object') {
    throw new Error(`${dir} is a backup in a format this version can't read`);
  }
  return manifest;
}

// Replaces the data of every collection in the backup with the backup's documents (collections not in it are left
// alone). Not one transaction: a restore stopped half-way can be run again. Returns the counts restored.
export async function restoreDatabase(db, dir) {
  const manifest = await readManifest(dir);
  const restored = {};
  for (const [collection, expected] of Object.entries(manifest.collections)) {
    const target = db.collection(collection);
    await target.deleteMany({});
    let batch = [];
    let count = 0;
    const lines = createInterface({ input: createReadStream(join(dir, `${collection}.jsonl`)), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      batch.push(EJSON.parse(line, { relaxed: false }));
      if (batch.length === BATCH) {
        await target.insertMany(batch, { ordered: true });
        count += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await target.insertMany(batch, { ordered: true });
      count += batch.length;
    }
    if (count !== expected) throw new Error(`${collection}: the backup lists ${expected} documents but has ${count}`);
    restored[collection] = count;
  }
  return restored;
}

const summary = (collections) =>
  Object.entries(collections)
    .map(([name, n]) => `  ${name}: ${n}`)
    .join('\n');

// CLI: node src/backups.js backup | restore <folder> --yes
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, folder] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const yes = process.argv.includes('--yes');
  // npm runs this from server/; a folder typed by the user is relative to where they typed it.
  const from = process.env.INIT_CWD ?? process.cwd();
  const expand = (p) => resolve(from, p.replace(/^~(?=\/|$)/, homedir()));
  // Backups hold customers' data and password hashes: never inside the (public) repository, where they could be
  // committed.
  const backupDir = expand(defaultBackupDir());
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  if (`${backupDir}${sep}`.startsWith(repo)) {
    console.error(
      `BACKUP_DIR (${backupDir}) is inside the repository. Choose a folder outside it, e.g. ~/Bazaar-backups.`,
    );
    process.exit(1);
  }
  if (command !== 'backup' && !(command === 'restore' && folder)) {
    console.error('Usage: npm run backup | npm run restore -- <backup folder> --yes');
    process.exit(1);
  }

  const config = loadConfig();
  // Without --yes a restore only says what it would do, before connecting at all.
  if (command === 'restore' && !yes) {
    try {
      const manifest = await readManifest(expand(folder));
      console.error(
        `This replaces the data in "${config.mongodbDb}" with the backup of "${manifest.database}" from ` +
          `${manifest.createdAt}:\n${summary(manifest.collections)}\nRun again with --yes to go ahead.`,
      );
    } catch (err) {
      console.error(err.message);
    }
    process.exit(1);
  }
  let connection;
  try {
    connection = await connectDb(config.mongodbUri, config.mongodbDb);
  } catch (err) {
    // The driver's message names the database host; only its kind is shown (see the atlas-troubleshooting skill).
    console.error(`Could not connect to the database (${err.name}). Check MONGODB_URI in server/.env.`);
    process.exit(1);
  }
  const { client, db } = connection;
  try {
    if (command === 'backup') {
      const { dir, collections } = await backupDatabase(db, backupDir);
      console.log(`Backed up "${config.mongodbDb}" to ${dir}\n${summary(collections)}`);
    } else {
      const dir = expand(folder);
      await readManifest(dir);
      // What's there now is saved first, so a restore can itself be undone.
      const before = await backupDatabase(db, backupDir, {
        name: `${config.mongodbDb}-before-restore`,
      });
      console.log(`Saved the current data first: ${before.dir}`);
      const restored = await restoreDatabase(db, dir);
      console.log(`Restored "${config.mongodbDb}" from ${dir}\n${summary(restored)}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
