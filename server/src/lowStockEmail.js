import { lowStockEmail, sendToAdmins } from './emails.js';
import { isoDay, LOW, LOW_STOCK_EMAIL, lowStockProducts } from './routes/dashboard.js';
import { runningOut } from './reorder.js';

// The admins' morning email of products running out. index.js calls this every minute; it sends once per India-time
// day, at the first call from SEND_HOUR on (the free plan sleeps, so that may be later). The day is claimed in
// `settings` before sending, so restarts and simultaneous calls send it once; a failed send is logged, not retried
// (tomorrow's list comes anyway). No email on a day when nothing is low or running out soon (reorder.js), nor while an admin has switched it off
// (`enabled: false`, from the dashboard).

export const SEND_HOUR = 9;
const LIST = 50;
const IST_OFFSET = 330 * 60_000;

// Returns what happened: 'off' (switched off), 'early' (before SEND_HOUR), 'done' (already sent or claimed today), 'none' (nothing low) or
// 'sent'.
export async function sendLowStockEmail(ctx, now = new Date()) {
  const { db } = ctx;
  if (new Date(now.getTime() + IST_OFFSET).getUTCHours() < SEND_HOUR) return 'early';
  const day = isoDay(now.getTime());
  const settings = db.collection('settings');
  const saved = await settings.findOne({ _id: LOW_STOCK_EMAIL });
  if (saved?.enabled === false) return 'off';
  if (saved?.day === day) return 'done';
  try {
    // Matches only if today isn't claimed yet; otherwise the upsert tries to insert a second document with this _id.
    await settings.updateOne({ _id: LOW_STOCK_EMAIL, day: { $ne: day } }, { $set: { day, at: now } }, { upsert: true });
  } catch (err) {
    if (err.code === 11000) return 'done';
    throw err;
  }

  const [products, total, soon] = await Promise.all([
    lowStockProducts(db, LIST),
    db.collection('products').countDocuments({ active: true, ...LOW }),
    // Also what runs out within two weeks at its recent sales (stage 75).
    runningOut(db, now, LIST),
  ]);
  if (!total && !soon.total) return 'none';
  await sendToAdmins(ctx, lowStockEmail(products, total, ctx.config.mail?.publicUrl, soon), 'the low-stock email');
  return 'sent';
}
