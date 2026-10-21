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
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
    // MongoDB deletes sessions once expiresAt has passed.
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('orders').createIndex({ userId: 1, createdAt: -1 }),
    db
      .collection('orders')
      .createIndex({ status: 1, expiresAt: 1 }, { partialFilterExpression: { status: 'awaiting_payment' } }),
    db
      .collection('orders')
      .createIndex(
        { 'payment.razorpayOrderId': 1 },
        { partialFilterExpression: { 'payment.razorpayOrderId': { $exists: true } } },
      ),
    db
      .collection('orders')
      .createIndex({ number: 1 }, { unique: true, partialFilterExpression: { number: { $exists: true } } }),
  ]);
}
