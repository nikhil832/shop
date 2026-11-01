# Running, configuring and deploying Bazaar

## Try it without a database

```bash
npm install
npm run demo     # in-memory MongoDB with sample products; open http://localhost:5173
```

Demo data lives in memory and is gone when you stop it. Demo mode also creates an admin account, `admin@bazaar.demo` / `demo-admin-123` (printed at startup), for trying the admin panel.

## Run against MongoDB Atlas

1. Copy `server/.env.example` to `server/.env` (a file; it is gitignored) and set `MONGODB_URI` to your Atlas connection string. In Atlas, allow your IP under Network Access.
2. Load the sample catalog once: `npm run seed` (it skips a database that already has products; `npm run seed -- --force` replaces them).
3. `npm run dev`: API on :4000, web app on http://localhost:5173 (proxies `/api`).

## Commands

```bash
npm test          # API tests (in-memory MongoDB, never your real database)
npm run test:e2e  # browser tests (Playwright with your installed Google Chrome; demo data)
npm run lint      # ESLint
npm run format    # Prettier (CI runs format:check)
npm run build && npm start   # production: one server on :4000 serves the UI and API
npm run make-admin -- you@example.com   # give a registered account the admin role (in MONGODB_URI's database)
npm run reset-two-step -- you@example.com   # switch off two-step login for a lost phone (logs the account out)
```

Env vars (`server/.env` or the environment): `MONGODB_URI` (required except in demo mode), `MONGODB_DB` (default `shop`), `PORT` (default 4000).

### Backups

Atlas's free tier keeps no backups of its own, so make one now and then (say, weekly, and before any big change):

```bash
npm run backup                                   # saves the database to ~/Bazaar-backups/shop-<date-time>/
npm run restore -- ~/Bazaar-backups/shop-2026-10-23-1405           # says what a restore would replace
npm run restore -- ~/Bazaar-backups/shop-2026-10-23-1405 --yes     # replaces the data with the backup
```

A backup is a folder with one file per collection (products, orders, customers, uploaded photos, coupons…) and a
`manifest.json` of the counts. Logins and one-time links are left out. The files hold customers' addresses and password
hashes, so they're readable only by your Mac user and kept outside the project folder (the command refuses a
`BACKUP_DIR` inside it): don't upload them anywhere public. A restore first saves what's there now
(`shop-before-restore-…`), so it can be undone, and the project's hook asks before running one. To check a backup without
touching the live data, restore it into another database: `MONGODB_DB=shop-restore-test npm run restore -- <folder> --yes`.

### Order emails (optional)

1. Create a free [Brevo](https://www.brevo.com) account (300 emails a day). Under Senders, domains & IPs → Senders, add and verify the address emails come from (your Gmail works; no domain needed).
2. SMTP & API → API keys → generate a key. Set `BREVO_API_KEY`, `MAIL_FROM` (the verified sender) and, for links in the emails, `PUBLIC_URL` (your site's address; default `http://localhost:5173`). `MAIL_FROM_NAME` defaults to `Bazaar`.
3. Optional: `ADMIN_EMAIL` says where new-order alerts go (one address, or several separated by commas). Without it they go to every admin account's email.
4. Restart: the server prints "Order emails: sent through Brevo". Without a key it prints each email's subject and recipient instead.

Emails sent from a Gmail address through Brevo can land in spam; a domain of your own, verified in Brevo, fixes that.

### Writing assistant (optional, paid per use)

1. Create an account at [console.anthropic.com](https://console.anthropic.com), add credit under Billing, and create an API key.
2. Set `ANTHROPIC_API_KEY` in `server/.env` (or on Render, under the service's Environment). `AI_MODEL` picks the model: `claude-opus-5-5` (the default, about ₹1.70 a draft) or `claude-haiku-5-5` (about ₹0.05 a draft).
3. Restart: the server prints "Writing assistant: on (…)" and the admin product form shows **Write for me**. `npm run demo` never uses the key, so the demo costs nothing.

### Razorpay (optional, test mode only)

1. In the Razorpay Dashboard, switch to **Test Mode**, then Account & Settings → API keys → generate a key.
2. Add `RAZORPAY_KEY_ID` (starts with `rzp_test_`) and `RAZORPAY_KEY_SECRET` to `server/.env`. Live keys are refused at startup.
3. Restart `npm run dev` (or `npm run demo`, which also reads them): the server prints "Online payments: Razorpay test mode" and checkout offers "Pay online". Pay with Razorpay's [test cards or UPI IDs](https://razorpay.com/docs/payments/payments/test-card-details/); no real money moves.
4. Optional webhook (needs a public URL): Dashboard → Webhooks → `https://<your-site>/api/razorpay/webhook`, events `payment.captured` and `order.paid`, and put its secret in `RAZORPAY_WEBHOOK_SECRET`.

## Deploy (Render)

`render.yaml` describes one free web service: it builds the React app, runs `npm start` (UI and API on one server, over HTTPS) and redeploys on every push to `main`. `GET /api/health` is its health check.

1. In Atlas, Network Access → add `0.0.0.0/0` (Render's free plan has no fixed IP address; the database password still protects it).
2. On [Render](https://render.com), New → Blueprint → pick this repository. When asked, set `MONGODB_URI`, and optionally the Razorpay test keys (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`); leave any you don't use empty.
3. Once it's live, set up the Razorpay webhook (step 4 above) with the Render address, put its secret in `RAZORPAY_WEBHOOK_SECRET` under the service's Environment, and save (it redeploys).
4. Optional: for **Write for me**, set `ANTHROPIC_API_KEY` (and `AI_MODEL` if you want another model) the same way.
5. For order emails, set `BREVO_API_KEY`, `MAIL_FROM` and `PUBLIC_URL` (the Render address) the same way, and optionally `ADMIN_EMAIL` for new-order alerts.
6. To be found on Google (free): in [Google Search Console](https://search.google.com/search-console) add the Render address as a **URL prefix** property and choose the **HTML tag** check. Copy only the `content="…"` code into `GOOGLE_SITE_VERIFICATION` on Render, save (it redeploys), then press Verify. Under Sitemaps, submit `sitemap.xml`. Google's [Rich Results Test](https://search.google.com/test/rich-results) shows what it reads from a product page.

The free plan sleeps after 15 minutes without visitors; the next visit takes about a minute to wake it. Unpaid online orders past their 30 minutes are cancelled once it's awake again.

Refunds are paid from your Razorpay balance, which is short of each payment by Razorpay's fee. In a fresh test account a full refund of the only payment therefore fails; the order page then offers admins **Retry refund** once the balance covers it.

Without keys the store works as before, with Cash on Delivery only. Tests never call Razorpay: they use a stand-in (`server/test/fake-razorpay.js`).
