import { MongoClient } from 'mongodb';

// Connects and makes sure indexes exist. Returns the client (for sessions/transactions and closing) and the db.
export async function connectDb(uri, dbName) {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  await ensureIndexes(db);
  return { client, db };
}

export async function ensureIndexes(db) {
  await Promise.all([
    db.collection('categories').createIndex({ slug: 1 }, { unique: true }),
    db.collection('products').createIndex({ slug: 1 }, { unique: true }),
    db.collection('products').createIndex({ categoryId: 1, price: 1 }),
    db.collection('products').createIndex({ brand: 1 }),
  ]);
}
