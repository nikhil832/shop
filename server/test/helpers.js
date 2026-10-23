import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { razorpayClient } from '../src/razorpay.js';
import { seedCatalog } from '../src/seed.js';
import { FAKE_KEYS, startFakeRazorpay } from './fake-razorpay.js';

// Starts the API on a fresh in-memory replica set seeded with the sample catalog.
// With { razorpay: true }, online payments are on, talking to a stand-in Razorpay (t.fake).
export async function startTestServer({ razorpay = false } = {}) {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const { client, db } = await connectDb(mongo.getUri(), 'test');
  await seedCatalog(db);
  const fake = razorpay ? await startFakeRazorpay() : null;
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
  };
  const server = createApp(ctx).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://localhost:${server.address().port}/api`;

  // A client with its own cookie jar, like one browser. `call` is a client that never logs in.
  // A Buffer body is sent as-is with `type` as its Content-Type (file uploads); non-JSON responses come back as Buffers.
  function browser() {
    let cookie = null;
    return async function call(method, path, body, type) {
      const headers = {};
      const raw = Buffer.isBuffer(body);
      if (body) headers['Content-Type'] = raw ? type : 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(base + path, { method, headers, body: raw ? body : body && JSON.stringify(body) });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const [pair] = setCookie.split(';');
        cookie = pair.endsWith('=') ? null : pair;
      }
      const isJson = res.headers.get('content-type')?.startsWith('application/json');
      const data = isJson ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, body: isJson || data.length ? data : null, headers: res.headers, setCookie };
    };
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
    server.close();
    await fake?.stop();
    await client.close();
    await mongo.stop();
  }

  // `uri` is the in-memory database's, for tests that run a command-line script against it (never Atlas).
  return { db, ctx, fake, mail, base, call, browser, webhook, stop, uri: mongo.getUri() };
}
