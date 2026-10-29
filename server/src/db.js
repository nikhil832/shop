import { MongoClient } from 'mongodb';
import { migrateAddresses } from './addressBook.js';
import { ACTIVITY_DAYS } from './activity.js';
import { HISTORY_DAYS } from './stockHistory.js';
import { KEEP_DAYS as SEARCH_KEEP_DAYS } from './searchInsights.js';
import { REPORT_DAYS } from './routes/errorReports.js';
import { DEVICE_FORGET_DAYS } from './loginAlerts.js';
import { CACHE_DAYS } from './smartSearch.js';

// Connects and makes sure indexes exist. Returns the client (for sessions/transactions and closing) and the db.
export async function connectDb(uri, dbName) {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  await ensureIndexes(db);
  await migrateAddresses(db);
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
  // One createIndexes command per collection, collections in parallel. Separate commands for one collection, all at
  // once while it was still being created, once left the products slug index missing at the start of a CI test.
  await Promise.all(
    Object.entries(INDEXES).map(([name, specs]) =>
      db.collection(name).createIndexes(specs.map(([key, options = {}]) => ({ key, ...options }))),
    ),
  );
}

// Every collection's indexes: [keys, options?].
const INDEXES = {
  // Product questions: the answered ones of a product, an asker's own, and the admin's lists.
  questions: [
    [{ productId: 1, hidden: 1, 'answer.at': -1 }],
    [{ userId: 1, productId: 1 }],
    [{ hidden: 1, answer: 1, createdAt: 1 }],
  ],
  // The admin activity log: newest first, by area or person; entries go after ACTIVITY_DAYS (a year).
  activity: [
    [{ at: 1 }, { expireAfterSeconds: ACTIVITY_DAYS * 86_400 }],
    [{ area: 1, at: -1 }],
    [{ 'by.id': 1, at: -1 }],
  ],
  // Size guides, found by category (stage 88).
  sizeGuides: [[{ categoryIds: 1 }]],
  // Bundles: found by the products in a cart or on a product page.
  bundles: [[{ productIds: 1, active: 1 }]],
  // Deliveries from suppliers, newest first, by supplier.
  stockReceipts: [[{ createdAt: -1 }], [{ supplier: 1, createdAt: -1 }], [{ purchaseOrderId: 1 }, { sparse: true }]],
  // Gift cards: by code (only once paid), by Razorpay order (payments and the webhook), by buyer, the sweep's lists;
  // unpaid ones go UNPAID_DAYS after they were started (payBy is unset once paid).
  giftCards: [
    [{ codeHash: 1 }, { unique: true, partialFilterExpression: { codeHash: { $exists: true } } }],
    [{ 'payment.razorpayOrderId': 1 }],
    [{ buyerId: 1, createdAt: -1 }],
    [{ status: 1, sendAt: 1 }],
    [{ status: 1, expiresAt: 1 }],
    [{ payBy: 1 }, { expireAfterSeconds: 0 }],
  ],
  // Search insights: one per week and search; gone KEEP_DAYS after the last one.
  searchStats: [
    [{ week: 1, term: 1 }, { unique: true }],
    [{ week: 1, count: -1 }],
    [{ lastAt: 1 }, { expireAfterSeconds: SEARCH_KEEP_DAYS * 86_400 }],
  ],
  // Store credit's history, newest first per customer.
  creditLedger: [[{ userId: 1, at: -1 }]],
  // Announcements: the one showing now is found by its end and start.
  announcements: [[{ endsAt: 1, startsAt: -1 }]],
  // Stock history: per product (or one variant), newest first; entries go after HISTORY_DAYS (a year).
  stockHistory: [
    [{ at: 1 }, { expireAfterSeconds: HISTORY_DAYS * 86_400 }],
    [{ productId: 1, at: -1 }],
    [{ productId: 1, variantId: 1, at: -1 }],
  ],
  // Browser error reports: one per problem, listed by latest report, deleted REPORT_DAYS after it.
  errorReports: [
    [{ key: 1 }, { unique: true }],
    [{ fixedAt: 1, lastAt: -1 }],
    [{ lastAt: 1 }, { expireAfterSeconds: REPORT_DAYS * 86_400 }],
  ],
  // Admins' browsers (hashed device cookies) per account, for new-browser login alerts; forgotten after a year unused.
  knownDevices: [
    [{ userId: 1, deviceHash: 1 }, { unique: true }],
    [{ lastAt: 1 }, { expireAfterSeconds: DEVICE_FORGET_DAYS * 86_400 }],
  ],
  // Plain-words search readings, remembered for a week.
  searchInterpretations: [[{ at: 1 }, { expireAfterSeconds: CACHE_DAYS * 86_400 }]],
  // Help requests: a customer's own, the admin inbox by status, and an order's.
  helpRequests: [[{ userId: 1, updatedAt: -1 }], [{ status: 1, updatedAt: 1 }], [{ orderId: 1 }]],
  // Scheduled sales: the sweep looks for ones to start and to end; products on sale by their sale.
  sales: [[{ startedAt: 1, startsAt: 1 }], [{ endedAt: 1, endsAt: 1 }]],
  categories: [[{ slug: 1 }, { unique: true }]],
  products: [
    [{ slug: 1 }, { unique: true }],
    [{ categoryId: 1, price: 1 }],
    [{ brand: 1 }],
    [{ 'sale.id': 1 }, { partialFilterExpression: { 'sale.id': { $exists: true } } }],
  ],
  // Admin → Customers filters by tag (stage 82).
  // Referral codes are unique (stage 87); friends are counted by who referred them.
  users: [
    [{ email: 1 }, { unique: true }],
    [{ tags: 1 }],
    [{ referralCode: 1 }, { unique: true, partialFilterExpression: { referralCode: { $exists: true } } }],
    [{ referredBy: 1 }],
  ],
  // MongoDB deletes sessions once expiresAt has passed.
  sessions: [
    [{ tokenHash: 1 }, { unique: true }],
    [{ expiresAt: 1 }, { expireAfterSeconds: 0 }],
  ],
  // Password reset links: looked up by token hash, counted per user for the hourly limit, deleted once expired.
  passwordResets: [
    [{ tokenHash: 1 }, { unique: true }],
    [{ userId: 1, createdAt: -1 }],
    [{ expiresAt: 1 }, { expireAfterSeconds: 0 }],
  ],
  // Email change links: one-time tokens, counted per user per hour, deleted a day after they stop working.
  emailChanges: [
    [{ tokenHash: 1 }, { unique: true }],
    [{ userId: 1, createdAt: -1 }],
    [{ expiresAt: 1 }, { expireAfterSeconds: 86_400 }],
  ],
  // Login attempts per (hashed) email, counted for the lock and deleted once they no longer count.
  loginAttempts: [[{ key: 1, at: -1 }], [{ expiresAt: 1 }, { expireAfterSeconds: 0 }]],
  orders: [
    [{ userId: 1, createdAt: -1 }],
    // The admin order list (newest first) and the sales dashboard (orders since a date).
    [{ createdAt: -1 }],
    [{ status: 1, expiresAt: 1 }, { partialFilterExpression: { status: 'awaiting_payment' } }],
    [{ 'payment.razorpayOrderId': 1 }, { partialFilterExpression: { 'payment.razorpayOrderId': { $exists: true } } }],
    [{ number: 1 }, { unique: true, partialFilterExpression: { number: { $exists: true } } }],
    // Orders with a product: frequently bought together (newest first) and whether a reviewer bought it.
    [{ 'items.productId': 1, createdAt: -1 }],
  ],
  // One review per customer per product; listed newest first per product and (for admins) overall.
  reviews: [
    [{ productId: 1, userId: 1 }, { unique: true }],
    [{ productId: 1, hidden: 1, createdAt: -1 }],
    [{ createdAt: -1 }],
  ],
  wishlist: [[{ userId: 1, productId: 1 }, { unique: true }], [{ userId: 1, addedAt: -1 }]],
  // The unused-upload sweep looks at uploads older than a day.
  images: [[{ createdAt: 1 }]],
  // Coupons by code; each customer uses a coupon once; a cancelled order's use is found by order.
  coupons: [[{ code: 1 }, { unique: true }]],
  couponRedemptions: [[{ couponId: 1, userId: 1 }, { unique: true }], [{ orderId: 1 }]],
  // One back-in-stock alert per customer per product, or per variant of it (variantId missing for the whole
  // product); the sweep looks them up by product.
  stockAlerts: [[{ userId: 1, productId: 1, variantId: 1 }, { unique: true }], [{ productId: 1 }]],
  // Returns: an order's (checked when asking for one) and the admin list by status.
  returns: [[{ orderId: 1, createdAt: -1 }], [{ status: 1, createdAt: -1 }]],
  // Supplier orders (stage 93): the list by status; deliveries by the order they came against.
  purchaseOrders: [[{ status: 1, createdAt: -1 }], [{ number: 1 }, { unique: true }]],
  // Collections (stage 91): addressed by slug; the home page's live ones in order.
  collections: [[{ slug: 1 }, { unique: true }], [{ onHome: 1, position: 1 }]],
  // Exchanges (stage 89): the same, plus a customer's (closing an account checks for open ones).
  exchanges: [[{ orderId: 1, createdAt: -1 }], [{ status: 1, createdAt: -1 }], [{ userId: 1, status: 1 }]],
  // Delivery areas by PIN code prefix, one per prefix.
  deliveryZones: [[{ prefix: 1 }, { unique: true }]],
  // Two-step login tickets, between the password and the code.
  loginChallenges: [
    [{ tokenHash: 1 }, { unique: true }],
    [{ expiresAt: 1 }, { expireAfterSeconds: 0 }],
  ],
  // Saved carts (one per user, by _id): the reminder sweep looks for ones left alone for a day.
  carts: [[{ remindedAt: 1, updatedAt: 1 }]],
  // Hourly limits (takeHourlySlot): gone an hour after their last use.
  rateLimits: [[{ expiresAt: 1 }, { expireAfterSeconds: 0 }]],
};
