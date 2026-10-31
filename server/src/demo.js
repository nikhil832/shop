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
// A few questions for the FAQ page (stage 130), so the demo shows one.
const now = new Date();
await db.collection('faqs').insertMany(
  [
    ['delivery', 'How much is delivery?', 'Delivery is free on orders of ₹499 or more; below that it is ₹40.'],
    [
      'payment',
      'Can I pay when my order arrives?',
      'Yes: choose Cash on Delivery at checkout.\n\nYou can also pay online by card, UPI or net banking.',
    ],
    [
      'returns',
      'How do I return something?',
      'Open the order under Your orders within 7 days of delivery and choose "Return items".',
    ],
  ].map(([topic, question, answer]) => ({
    topic,
    question,
    answer,
    position: 1,
    active: true,
    createdAt: now,
    updatedAt: now,
  })),
);
await client.close();

console.log('Demo mode: in-memory database with sample products (data is lost when this stops).');
console.log(`Demo admin login: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}`);
await import('./index.js');
