// Runs the store against a throwaway in-memory MongoDB with sample data: `npm run demo`, and the e2e tests.
// A replica set, because placing orders uses transactions. Nothing here touches your real database.
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDb } from './db.js';
import { hashPassword } from './auth.js';
import { seedCatalog } from './seed.js';

const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'demo';
// Demo accounts are made up: never email them, even with a Brevo key in .env (set, even empty, beats the file).
process.env.BREVO_API_KEY = '';
// Nor spend money on Claude's API: the writing assistant is on in the demo only when pointed at the tests' stand-in.
if (!process.env.ANTHROPIC_API_URL) process.env.ANTHROPIC_API_KEY = '';
process.once('exit', () => mongo.stop());

const { client, db } = await connectDb(process.env.MONGODB_URI, process.env.MONGODB_DB);
await seedCatalog(db);
// A known admin login, only ever in this throwaway database (used by the e2e tests too).
const DEMO_ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' };
await db.collection('users').insertOne({
  name: 'Demo Admin',
  email: DEMO_ADMIN.email,
  passwordHash: await hashPassword(DEMO_ADMIN.password),
  role: 'admin',
  createdAt: new Date(),
});
await client.close();

console.log('Demo mode: in-memory database with sample products (data is lost when this stops).');
console.log(`Demo admin login: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}`);
await import('./index.js');
