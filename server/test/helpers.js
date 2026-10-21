import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { seedCatalog } from '../src/seed.js';

// Starts the API on a fresh in-memory replica set seeded with the sample catalog.
export async function startTestServer() {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const { client, db } = await connectDb(mongo.getUri(), 'test');
  await seedCatalog(db);
  const server = createApp({ db, client, config: {} }).listen(0);
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

  async function stop() {
    server.close();
    await client.close();
    await mongo.stop();
  }

  return { db, call, browser, stop };
}
