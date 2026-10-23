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
  // Stage 23 lets a customer watch several sizes of one product: the old one-alert-per-product unique index goes, and
  // the one below (with variantId) replaces it. Missing index or collection (a new database) is fine.
  await db
    .collection('stockAlerts')
    .dropIndex('userId_1_productId_1')
    .catch((err) => {
      if (![26, 27].includes(err.code)) throw err; // NamespaceNotFound, IndexNotFound
    });
  await Promise.all([
    db.collection('categories').createIndex({ slug: 1 }, { unique: true }),
    db.collection('products').createIndex({ slug: 1 }, { unique: true }),
    db.collection('products').createIndex({ categoryId: 1, price: 1 }),
    db.collection('products').createIndex({ brand: 1 }),
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
    // MongoDB deletes sessions once expiresAt has passed.
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Password reset links: looked up by token hash, counted per user for the hourly limit, deleted once expired.
    db.collection('passwordResets').createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection('passwordResets').createIndex({ userId: 1, createdAt: -1 }),
    db.collection('passwordResets').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Email change links: one-time tokens, counted per user per hour, deleted a day after they stop working.
    db.collection('emailChanges').createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection('emailChanges').createIndex({ userId: 1, createdAt: -1 }),
    db.collection('emailChanges').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 86_400 }),
    // Login attempts per (hashed) email, counted for the lock and deleted once they no longer count.
    db.collection('loginAttempts').createIndex({ key: 1, at: -1 }),
    db.collection('loginAttempts').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('orders').createIndex({ userId: 1, createdAt: -1 }),
    // The admin order list (newest first) and the sales dashboard (orders since a date).
    db.collection('orders').createIndex({ createdAt: -1 }),
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
    // One review per customer per product; listed newest first per product and (for admins) overall.
    db.collection('reviews').createIndex({ productId: 1, userId: 1 }, { unique: true }),
    db.collection('reviews').createIndex({ productId: 1, hidden: 1, createdAt: -1 }),
    db.collection('reviews').createIndex({ createdAt: -1 }),
    db.collection('wishlist').createIndex({ userId: 1, productId: 1 }, { unique: true }),
    // Coupons by code; each customer uses a coupon once; a cancelled order's use is found by order.
    // The unused-upload sweep looks at uploads older than a day.
    db.collection('images').createIndex({ createdAt: 1 }),
    db.collection('coupons').createIndex({ code: 1 }, { unique: true }),
    db.collection('couponRedemptions').createIndex({ couponId: 1, userId: 1 }, { unique: true }),
    db.collection('couponRedemptions').createIndex({ orderId: 1 }),
    // One back-in-stock alert per customer per product, or per variant of it (variantId missing for the whole
    // product); the sweep looks them up by product.
    db.collection('stockAlerts').createIndex({ userId: 1, productId: 1, variantId: 1 }, { unique: true }),
    db.collection('stockAlerts').createIndex({ productId: 1 }),
    db.collection('wishlist').createIndex({ userId: 1, addedAt: -1 }),
    // Returns: an order's (checked when asking for one) and the admin list by status.
    db.collection('returns').createIndex({ orderId: 1, createdAt: -1 }),
    db.collection('returns').createIndex({ status: 1, createdAt: -1 }),
  ]);
}
