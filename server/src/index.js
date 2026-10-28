import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDb } from './db.js';
import { createApp } from './app.js';
import { razorpayClient } from './razorpay.js';
import { mailClient } from './mail.js';
import { aiClient } from './ai.js';
import { expireUnpaidOrders } from './routes/orders.js';
import { sendBackInStockAlerts } from './routes/stockAlerts.js';
import { sendPriceDropEmails } from './routes/wishlist.js';
import { sendCartReminders } from './routes/savedCart.js';
import { deleteUnusedImages } from './routes/images.js';
import { sendLowStockEmail } from './lowStockEmail.js';
import { sendWeeklyNote } from './weeklyNote.js';
import { updateReviewSummaries } from './reviewSummaries.js';
import { screenPosts } from './screening.js';
import { runSales } from './sales.js';
import { remindGiftCards, sendScheduledGiftCards } from './giftCards.js';
import { payCashback } from './cashback.js';
import { payReferrals } from './referrals.js';
import { loadConfig } from './config.js';
import { previewRouter } from './preview.js';
import { checkStorage } from './storage.js';

const config = loadConfig();
const CLIENT_DIST = fileURLToPath(new URL('../../client/dist', import.meta.url));

const { client, db } = await connectDb(config.mongodbUri, config.mongodbDb);
const ctx = {
  db,
  client,
  config,
  razorpay: razorpayClient(config.razorpay),
  mail: mailClient(config.mail),
  ai: aiClient(config.ai),
};
const app = createApp(ctx);

// Every minute: start and end scheduled sales, release the stock of online orders whose 30-minute payment window has
// passed, then email customers waiting for products that are back in stock (which that release can cause), those whose
// wishlist got cheaper and those who left a cart a day ago, once a morning the admins' list of products running out,
// on Mondays their weekly note, rewrite "What customers say" for products whose reviews changed, screen new
// reviews and questions, and send gift cards whose day has come.
const sweeper = setInterval(async () => {
  // First, so a sale starting or ending now is in the prices the emails below read.
  await runSales(ctx).catch((err) => console.error(err));
  await expireUnpaidOrders(ctx).catch((err) => console.error(err));
  await sendBackInStockAlerts(ctx).catch((err) => console.error(err));
  await sendPriceDropEmails(ctx).catch((err) => console.error(err));
  await sendCartReminders(ctx).catch((err) => console.error(err));
  await sendLowStockEmail(ctx).catch((err) => console.error(err));
  await sendWeeklyNote(ctx).catch((err) => console.error(err));
  await updateReviewSummaries(ctx).catch((err) => console.error(err));
  await screenPosts(ctx).catch((err) => console.error(err));
  // Gift cards for today, and reminders a month before one runs out (giftCards.js).
  await sendScheduledGiftCards(ctx).catch((err) => console.error(err));
  await remindGiftCards(ctx).catch((err) => console.error(err));
  // Cashback for orders kept past their return window (cashback.js).
  await payCashback(ctx).catch((err) => console.error(err));
  // Rewards for referring a friend whose first order was kept (referrals.js).
  await payReferrals(ctx).catch((err) => console.error(err));
}, 60_000);

// At startup (the free plan sleeps, so hourly runs may not come) and then every hour: delete uploaded photos that no
// product or order uses and that are more than a day old.
async function cleanUpImages() {
  const { deleted, bytes } = await deleteUnusedImages(ctx);
  if (deleted) console.log(`Deleted ${deleted} unused uploaded photo(s), ${(bytes / 1024 / 1024).toFixed(1)} MB.`);
}
cleanUpImages().catch((err) => console.error(err));
// After each clean-up, how full the database is (an email to the admins at 80% and 95%).
const imageSweeper = setInterval(
  () =>
    cleanUpImages()
      .then(() => checkStorage(ctx))
      .catch((err) => console.error(err)),
  60 * 60_000,
);

// In production, serve the built React app from the same server. Pages get link-preview tags (preview.js); the
// static files' own index.html is not served as-is (index: false), so the home page gets them too.
if (existsSync(CLIENT_DIST)) {
  // Built code and styles have a hash of their content in the name, so browsers may keep them for good. A name the
  // build no longer has (a tab open since the last deploy) is a 404, not the app's page; the client then reloads.
  app.use('/assets', express.static(join(CLIENT_DIST, 'assets'), { index: false, immutable: true, maxAge: '1y' }));
  app.use('/assets', (req, res) => res.status(404).type('text/plain').send('Not found'));
  app.use(express.static(CLIENT_DIST, { index: false }));
  app.use(previewRouter(ctx, readFileSync(join(CLIENT_DIST, 'index.html'), 'utf8')));
}

const server = app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port} (database "${config.mongodbDb}")`);
  console.log(ctx.ai ? `Writing assistant: on (${ctx.ai.model}).` : 'Writing assistant: off (no ANTHROPIC_API_KEY).');
  console.log(ctx.razorpay ? 'Online payments: Razorpay test mode.' : 'Online payments: off (Cash on Delivery only).');
  console.log(ctx.mail.enabled ? 'Order emails: sent through Brevo.' : 'Order emails: printed here, not sent.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(sweeper);
    clearInterval(imageSweeper);
    server.close();
    client.close().finally(() => process.exit(0));
  });
}
