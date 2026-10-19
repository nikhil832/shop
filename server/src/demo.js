// Runs the store against a throwaway in-memory MongoDB with sample data: `npm run demo`, and the e2e tests.
// A replica set, because placing orders uses transactions. Nothing here touches your real database.
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDb } from './db.js';
import { seedCatalog } from './seed.js';

const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'demo';
process.once('exit', () => mongo.stop());

const { client, db } = await connectDb(process.env.MONGODB_URI, process.env.MONGODB_DB);
await seedCatalog(db);
await client.close();

console.log('Demo mode: in-memory database with sample products (data is lost when this stops).');
await import('./index.js');
