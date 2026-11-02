import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { razorpayClient } from '../src/razorpay.js';
import { seedCatalog } from '../src/seed.js';
import { FAKE_KEYS, startFakeRazorpay } from './fake-razorpay.js';
import { aiClient } from '../src/ai.js';
import { FAKE_ANTHROPIC_KEY, startFakeAnthropic } from './fake-anthropic.js';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';

// A test file still running after FILE_LIMIT_MS says what it was doing and exits, so CI fails within minutes, naming
// the file and the step it was stuck in (added while CI hung; the cause was spawnSync, see runScript below). The timer
// is unref'd, so it never keeps a finished file alive. TEST_FILE_LIMIT_MS overrides it (to try it out).
const FILE_LIMIT_MS = Number(process.env.TEST_FILE_LIMIT_MS) || 4 * 60_000;
let step = 'loading';
setTimeout(() => {
  console.error(
    `${basename(process.argv[1] ?? 'test file')} was still ${step} after ${FILE_LIMIT_MS / 1000} s; stopping it.`,
  );
  process.exit(1);
}, FILE_LIMIT_MS).unref();
// Runs one of the server's command-line scripts (`args`, e.g. ['src/make-admin.js', email]) with `env` and waits
// for it without blocking. Tests used spawnSync, which froze the test process: it then stopped reading the in-memory
// MongoDB's log pipe, and when the pipe filled MongoDB stalled, the script waited for it forever, and CI hung (five
// times, seen in run 41238419033's process list). Stopped after 60 s, so a stuck script fails the test by itself.
export function runScript(args, env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: new URL('..', import.meta.url),
        env: { PATH: process.env.PATH, ...env },
        encoding: 'utf8',
        timeout: 60_000,
      },
      (err, stdout, stderr) =>
        resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
    );
  });
}

// Gives up on `promise` after `ms`, saying what took too long (used for shutting things down).
const within = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((resolve) =>
      setTimeout(() => {
        console.error(`${what} took more than ${ms / 1000} s; carrying on.`);
        resolve();
      }, ms).unref(),
    ),
  ]);

// Starts the API on a fresh in-memory replica set seeded with the sample catalog.
// With { razorpay: true }, online payments are on, talking to a stand-in Razorpay (t.fake).
// With { ai: 'model-id' }, the writing assistant is on, talking to a stand-in Claude API (t.claude).
export async function startTestServer({ razorpay = false, ai = null } = {}) {
  step = 'starting the in-memory MongoDB';
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  step = 'connecting to the in-memory MongoDB';
  const { client, db } = await connectDb(mongo.getUri(), 'test');
  step = 'seeding the sample catalog';
  await seedCatalog(db);
  const fake = razorpay ? await startFakeRazorpay() : null;
  const claude = ai ? await startFakeAnthropic() : null;
  // Records order emails instead of sending them (t.mail.sent); t.mail.failNext() makes the next send throw.
  const mail = {
    enabled: true,
    sent: [],
    failing: false,
    failNext() {
      this.failing = true;
    },
    async send(message) {
      if (this.failing) {
        this.failing = false;
        throw new Error('mail service down');
      }
      this.sent.push(message);
    },
  };
  const ctx = {
    db,
    client,
    config: { mail: { publicUrl: 'https://bazaar.test' } },
    razorpay: fake && razorpayClient({ ...FAKE_KEYS, apiUrl: fake.url }),
    mail,
    ai: claude && aiClient({ apiKey: FAKE_ANTHROPIC_KEY, model: ai, apiUrl: claude.url }),
  };
  const server = createApp(ctx).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://localhost:${server.address().port}/api`;
  step = 'running its tests';

  // A client with its own cookie jar, like one browser (`extraHeaders`, e.g. a User-Agent, go with every request).
  // `call` is a client that never logs in.
  // A Buffer body is sent as-is with `type` as its Content-Type (file uploads); non-JSON responses come back as Buffers.
  function browser(extraHeaders = {}) {
    const cookies = new Map();
    async function call(method, path, body, type) {
      const headers = { ...extraHeaders };
      const raw = Buffer.isBuffer(body);
      if (body) headers['Content-Type'] = raw ? type : 'application/json';
      if (cookies.size) headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      // Redirects come back as they are (Google login's 302s, stage 151), with `headers.location`.
      const res = await fetch(base + path, {
        method,
        headers,
        body: raw ? body : body && JSON.stringify(body),
        redirect: 'manual',
      });
      const setCookie = res.headers.get('set-cookie');
      for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
        if (value) cookies.set(name, value);
        else cookies.delete(name);
      }
      const isJson = res.headers.get('content-type')?.startsWith('application/json');
      const data = isJson ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, body: isJson || data.length ? data : null, headers: res.headers, setCookie };
    }
    call.cookies = cookies;
    return call;
  }
  const call = browser();

  // Delivers a Razorpay webhook: the exact body bytes with their signature header.
  async function webhook(rawBody, signature) {
    const res = await fetch(`${base}/razorpay/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature },
      body: rawBody,
    });
    return { status: res.status, body: await res.json() };
  }

  async function stop() {
    step = 'stopping its servers';
    server.close();
    await fake?.stop();
    await claude?.stop();
    await within(client.close(), 30_000, 'Closing the database connection');
    step = 'stopping the in-memory MongoDB';
    await within(mongo.stop(), 30_000, 'Stopping the in-memory MongoDB');
    step = 'finishing after stop()';
  }

  // `uri` is the in-memory database's, for tests that run a command-line script against it (never Atlas).
  // `runScript(args)`: a command-line script against this test's own database (env vars win over server/.env, so Atlas
  // is never touched).
  const script = (args) => runScript(args, { MONGODB_URI: mongo.getUri(), MONGODB_DB: 'test' });
  return { db, ctx, fake, claude, mail, base, call, browser, webhook, stop, uri: mongo.getUri(), runScript: script };
}
