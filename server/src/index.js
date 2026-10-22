import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectDb } from './db.js';
import { createApp } from './app.js';
import { razorpayClient } from './razorpay.js';
import { mailClient } from './mail.js';
import { expireUnpaidOrders } from './routes/orders.js';
import { sendBackInStockAlerts } from './routes/stockAlerts.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const CLIENT_DIST = fileURLToPath(new URL('../../client/dist', import.meta.url));

const { client, db } = await connectDb(config.mongodbUri, config.mongodbDb);
const ctx = { db, client, config, razorpay: razorpayClient(config.razorpay), mail: mailClient(config.mail) };
const app = createApp(ctx);

// Every minute: release the stock of online orders whose 30-minute payment window has passed, then email customers
// waiting for products that are back in stock (which that release can cause).
const sweeper = setInterval(async () => {
  await expireUnpaidOrders(ctx).catch((err) => console.error(err));
  await sendBackInStockAlerts(ctx).catch((err) => console.error(err));
}, 60_000);

// In production, serve the built React app from the same server.
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('/{*splat}', (req, res) => res.sendFile('index.html', { root: CLIENT_DIST }));
}

const server = app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port} (database "${config.mongodbDb}")`);
  console.log(ctx.razorpay ? 'Online payments: Razorpay test mode.' : 'Online payments: off (Cash on Delivery only).');
  console.log(ctx.mail.enabled ? 'Order emails: sent through Brevo.' : 'Order emails: printed here, not sent.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(sweeper);
    server.close();
    client.close().finally(() => process.exit(0));
  });
}
