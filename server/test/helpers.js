import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { razorpayClient } from '../src/razorpay.js';
import { seedCatalog } from '../src/seed.js';
import { FAKE_KEYS, startFakeRazorpay } from './fake-razorpay.js';
import { aiClient } from '../src/ai.js';
import { FAKE_ANTHROPIC_KEY, startFakeAnthropic } from './fake-anthropic.js';
import { basename } from 'node:path';

// CI hung four times with one test file (variants.test.js) never finishing, past the runner's per-test timeout, so
// the job sat silent until GitHub's 20-minute limit. Each file therefore notes what it is doing, and one still running
// after FILE_LIMIT_MS says so and exits: CI then fails within minutes, naming the file and the step it was stuck in.
// The timer is unref'd, so it never keeps a finished file alive. TEST_FILE_LIMIT_MS overrides it (to try it out).
const FILE_LIMIT_MS = Number(process.env.TEST_FILE_LIMIT_MS) || 4 * 60_000;
let step = 'loading';
setTimeout(() => {
  console.error(
    `${basename(process.argv[1] ?? 'test file')} was still ${step} after ${FILE_LIMIT_MS / 1000} s; stopping it.`,
  );
  process.exit(1);
}, FILE_LIMIT_MS).unref();
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
      const res = await fetch(base + path, { method, headers, body: raw ? body : body && JSON.stringify(body) });
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
  return { db, ctx, fake, claude, mail, base, call, browser, webhook, stop, uri: mongo.getUri() };
}
