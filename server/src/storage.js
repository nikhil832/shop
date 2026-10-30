import { sendToAdmins } from './emails.js';

// How much of the database's space is used: Atlas's free tier holds 512 MB (STORAGE_LIMIT_MB to change), and photos
// (products' and reviews') take most of it. Measured as data plus indexes before compression, which is at least what
// Atlas counts, so the meter errs on the early side. Admins see it on the dashboard and are emailed as it fills up.

export const WARN_PERCENT = [80, 95]; // the levels that send an email
const REMIND_MS = 7 * 86_400_000; // while still that full, a reminder at most once a week
const ALERT_ID = 'storageAlert'; // its `settings` document: { level, at }

// What people call each collection, for the dashboard and the email.
const NAMES = {
  images: 'Photos',
  products: 'Products',
  orders: 'Orders',
  users: 'Accounts',
  reviews: 'Reviews',
  reviewVotes: 'Helpful votes on reviews',
  questions: 'Questions',
  activity: 'Activity log',
  stockHistory: 'Stock history',
  announcements: 'Announcements',
  creditLedger: 'Store credit',
  searchStats: 'Search insights',
  giftCards: 'Gift cards',
  stockReceipts: 'Deliveries received',
  bundles: 'Bundles',
  sizeGuides: 'Size guides',
  errorReports: 'Error reports',
  carts: 'Saved carts',
  wishlist: 'Wishlists',
  returns: 'Returns',
  sessions: 'Logins',
  categories: 'Categories',
  coupons: 'Coupons',
  couponRedemptions: 'Coupon uses',
  stockAlerts: 'Stock alerts',
  deliveryZones: 'Delivery areas',
  passwordResets: 'Password reset links',
  emailChanges: 'Email changes',
  loginAttempts: 'Login attempts',
  loginChallenges: 'Two-step logins',
  knownDevices: 'Admin browsers',
  searchInterpretations: 'Plain-words searches',
  helpRequests: 'Help requests',
  rateLimits: 'Rate limits',
  settings: 'Settings',
  counters: 'Order numbers',
};

// { usedBytes, limitBytes, percent, collections: [{ name, label, bytes }] (largest first) }, or null when the
// database won't say (the dashboard then shows the rest without it). Hosted plans can refuse some statistics commands:
// without per-collection sizes, the total is still shown.
export async function storageUse(db, config) {
  let stats;
  try {
    stats = await db.command({ dbStats: 1 });
  } catch (err) {
    console.error('Could not read the database size:', err.message);
    return null;
  }
  const collections = (await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray()).filter(
    (c) => !c.name.startsWith('system.'),
  );
  const sizes = await Promise.all(
    collections.map(async ({ name }) => {
      const [s] = await db
        .collection(name)
        .aggregate([{ $collStats: { storageStats: {} } }])
        .toArray()
        .catch(() => []);
      return {
        name,
        label: NAMES[name] ?? name,
        bytes: (s?.storageStats.size ?? 0) + (s?.storageStats.totalIndexSize ?? 0),
      };
    }),
  );
  const usedBytes = stats.dataSize + stats.indexSize;
  const limitBytes = (config?.storageLimitMb ?? 512) * 1024 * 1024;
  return {
    usedBytes,
    limitBytes,
    percent: Math.round((usedBytes / limitBytes) * 1000) / 10,
    collections: sizes.filter((c) => c.bytes > 0).sort((a, b) => b.bytes - a.bytes),
  };
}

// "12.3 MB", or "640 KB" below a megabyte.
const mb = (bytes) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function storageEmail(use, level) {
  const subject = `Database storage is ${Math.floor(use.percent)}% full`;
  const lines = [
    `The store's database uses ${mb(use.usedBytes)} of its ${mb(use.limitBytes)} (${use.percent}%). Past ${level}%, it's time to make room before saving starts to fail.`,
    `Biggest: ${use.collections
      .slice(0, 4)
      .map((c) => `${c.label} ${mb(c.bytes)}`)
      .join(', ')}.`,
    'Photos no product, order or review uses are deleted after a day by themselves. To make more room: delete photos of products you no longer sell (hidden products keep theirs), or move to a bigger Atlas plan.',
  ];
  const text = [...lines, 'Bazaar · a demo store'].join('\n\n');
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111827">${lines
    .map((l) => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`)
    .join(
      '',
    )}<p style="font-size:12px;color:#6b7280">You're getting this email because you're an admin of the store.</p></body></html>`;
  return { subject, text, html };
}

// Run hourly by index.js (and directly by tests, with `now`). Emails the admins when use passes a WARN_PERCENT level,
// and again at most weekly while it stays there; going back below resets it. Returns the level emailed about, or 0.
export async function checkStorage(ctx, now = new Date()) {
  const { db } = ctx;
  const use = await storageUse(db, ctx.config);
  if (!use) return 0;
  const level = WARN_PERCENT.filter((p) => use.percent >= p).at(-1) ?? 0;
  const settings = db.collection('settings');
  const last = await settings.findOne({ _id: ALERT_ID });
  if (!level) {
    if (last?.level) await settings.updateOne({ _id: ALERT_ID }, { $set: { level: 0, at: now } });
    return 0;
  }
  const due = !last || level > (last.level ?? 0) || now - last.at >= REMIND_MS;
  if (!due) return 0;
  await settings.updateOne({ _id: ALERT_ID }, { $set: { level, at: now } }, { upsert: true });
  await sendToAdmins(ctx, storageEmail(use, level), 'the storage warning');
  return level;
}
