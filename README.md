# Bazaar

An online store in the style of the big marketplaces: React (Vite) frontend, Express API, MongoDB (Atlas).

Built in stages. Done so far:

1. **Catalog**: categories, search, filters (brand, price, rating, availability), sorting, pagination, product pages.
2. **Accounts, cart and checkout**: sign up and log in, a cart kept in the browser (no login needed to shop), checkout with Cash on Delivery, order history, and cancelling an order that hasn't shipped. Delivery is free from ₹499, otherwise ₹40.

3. **Admin panel** (`/admin`, admins only): orders (search, filter by status, mark shipped → delivered, cancel with stock returned), products (add and edit with photo uploads, quick stock edits, hide/show), and categories (add, rename, reorder, delete when empty).

4. **Online payments** with Razorpay in **test mode**: UPI, cards, netbanking and wallets next to Cash on Delivery. Stock is held for 30 minutes while the customer pays; unpaid orders then expire. Payments are verified on the server (signature + Razorpay API, and a webhook as backup); cancelling a paid order refunds it automatically.

5. **Reviews and wishlist**: customers rate and review products they've received (one review each, which they can edit or delete); new reviews are added to the sample ratings. Admins can hide a review, which also takes it out of the rating. A wishlist kept in the account, with a Wishlist page next to My orders.

6. **Order emails** through [Brevo](https://www.brevo.com): the customer hears when an order is confirmed (for online orders, once paid), shipped, delivered (with links to review each item) and cancelled (saying whether a refund was started). Without a Brevo key, emails are printed in the server log instead.

7. **Password reset by email**: "Forgot password?" on the login page emails a one-time link (valid for 1 hour); choosing a new password logs you out everywhere else.

8. **Better search**: words also match category names and product highlights, plurals and a few synonyms work ("phones" finds the Mobiles category), whole words only ("book" doesn't find Chromebooks), and results are ranked by how well they match, then popularity.

9. **Login protection**: after 5 wrong passwords, login for that email pauses for 15 minutes (a password reset ends it sooner), and a reset can't reuse the current password.

10. **Account page** (`/account`): change your name, edit or remove the saved address checkout fills in, and change your password (the current one is needed, it can't be reused, and other devices are logged out).

11. **Back-in-stock alerts**: on a sold-out product, logged-in customers click "Email me when it's back" and get one email when it's in stock again (checked every minute, however the stock came back).

12. **Search suggestions**: typing in the header's search box shows matching categories and the best 6 products (ranked like search), plus "See all N results"; arrow keys, Enter and Escape work too.

13. **Coupon codes**: admins create codes (percentage off with an optional cap, an amount off, or free delivery; optional minimum order, last day and total uses) under Admin → Coupons, and switch them on or off. Customers apply one at checkout; each customer can use a code once, and cancelling the order gives the use back.

14. **Sales dashboard**: the admin panel opens on a dashboard for the last 7, 30 or 90 days: revenue, orders, average order and discounts given (compared with the period before), revenue per day as a chart (also as a table), best sellers, orders waiting to ship, and products running low.

15. **New-order alerts**: admins get an email for every new order (Cash on Delivery straight away, online orders once paid) with the customer, items, total, payment and delivery city, and a link to the order in the admin panel. They go to every admin account, or to `ADMIN_EMAIL` if it's set.

16. **Unused uploads cleaned up**: photos uploaded in the admin panel but never saved to a product (or replaced since) are deleted once they're a day old, checked at startup and every hour, so they don't fill the free database. Photos that past orders show are kept.

17. **Login limit per network**: besides the 5-per-email lock, more than 20 wrong passwords from one network (an IP address, or an IPv6 /64) within 15 minutes pause login from that network, whichever emails were tried, so nobody can try one common password on many accounts. Generous on purpose: mobile networks put many people behind one address. On Render the visitor's address comes from the `CF-Connecting-IP` header (`CLIENT_IP_HEADER` in `render.yaml`).

18. **Change email**: on the account page, enter the new address and your password; a link (valid 24 hours) goes to the new address, and the email changes only once it's opened (on any device). The old address is then told, and reset links sent to it stop working. A waiting change shows on the account page and can be cancelled.

19. **Printable invoices**: placed, shipped and delivered orders have an Invoice button (for the customer on their order page, for admins on the admin order page) that opens a bill with the order number and date, billing address and email, items, delivery, coupon, total and how it's paid. "Print or save as PDF" prints just the invoice, black on white.

20. **Export orders**: on the admin dashboard, choose two dates (India time, both included) and optionally a status, and download a CSV for Excel or Google Sheets: one row per order with its number, date and time, status, customer and email, items, amounts in rupees (items, delivery, discount, coupon, total), payment and delivery city, state and PIN code.

21. **Product variants**: a product can come in one kind of option (sizes, colours…), each with its own price, MRP and stock. Customers pick one on the product page (sold-out ones are crossed out); listings say "from ₹…" when prices differ, and the cart, checkout, orders, invoices and exports name the variant ("Stride Running Shoes (Size: UK 8)"). Admins switch variants on in the product form and edit them in a table. The demo's Stride Running Shoes and Urbane Women Kurta Set have sizes.

22. **Photos per variant**: in the product form, tick which of the product's photos belong to each variant; choosing that variant in the store shows only its photos, and its cart and order lines use its first one. With none ticked, a variant shows all the product's photos. The demo's Ziva Women Handbag has a Black and a Tan.

23. **Alerts per size**: a sold-out size or colour stays choosable (crossed out) while others are in stock; choosing it offers "Email me when UK 10's back", and the email names the size. A customer can watch several sizes of one product; an alert for a size an admin deletes is dropped.

24. **Two options**: a product can have two kinds of option, e.g. Colour and Waist, each combination with its own price, stock and photos (combinations not sold are simply left out). In the store, the second row of choices follows the first (a waist not made in the chosen colour can't be picked) and choosing just a colour already shows its photos; lines read "Urbane Men Slim Fit Jeans (Colour: Black, Waist: 32)". In the admin form, "Add a second option" adds a column, and "Add missing combinations" fills in the grid. The demo's jeans come in Blue and Black.

25. **Database backups**: `npm run backup` saves the Atlas database to a dated folder on your computer (outside the project), and `npm run restore` puts one back (see [Backups](#backups)).

26. **Tracking numbers**: when marking an order shipped, the admin can enter the courier, the tracking number and the courier's tracking link (pasted from its site); they can be added or corrected later. The customer sees them on the order page, with a "Track your parcel" link, and in the shipped email; the order export has them too.

27. **Link previews**: a product link shared on WhatsApp, Instagram, Facebook or X shows a card with its name and price ("from ₹…" for variants at different prices), brand and highlights, and its first uploaded photo; every other page, and products with only the generated sample pictures (previews can't show SVG), use the store's own Bazaar image. The browser tab shows the product's name too.

28. **Returns**: for 7 days after delivery, customers can ask to return some items of an order (how many of each, a reason and a note); the refund is those items' price less their share of any coupon, without the delivery. Admins are emailed and decide in Admin → Returns: approving (once the items are back) puts the stock back and refunds online payments through Razorpay; for Cash on Delivery the admin pays the customer and marks it refunded. Declining says why. The customer is emailed either way and sees the status on the order page.

29. **Delivery PIN check**: product pages have "Check delivery": enter a PIN code to see whether it's delivered there and by when (e.g. "by Sat, 24 Oct – Sun, 25 Oct"); the saved address's PIN, or the last one checked, is filled in. In Admin → Delivery, areas by the first digits of the PIN code (560 = Bengaluru, 1–2 days; 79 = not delivered; the longest match wins) and a rule for everywhere else (3–7 days until set). Checkout refuses addresses the store doesn't deliver to.

30. **Two-step login**: on the account page, anyone can turn on login codes from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…): confirm the password, scan the QR code or type the key, enter a code, and save the 8 one-time recovery codes. Logging in then asks for a code after the password (5 wrong codes per try; each code works once), a password reset link no longer logs in by itself, and turning it off needs the password and a code. The admin panel reminds admins without it. Lost the phone and the recovery codes: `npm run reset-two-step -- <email>` (database credentials needed).

What's next: see [ROADMAP.md](ROADMAP.md).

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
4. For order emails, set `BREVO_API_KEY`, `MAIL_FROM` and `PUBLIC_URL` (the Render address) the same way, and optionally `ADMIN_EMAIL` for new-order alerts.

The free plan sleeps after 15 minutes without visitors; the next visit takes about a minute to wake it. Unpaid online orders past their 30 minutes are cancelled once it's awake again.

Refunds are paid from your Razorpay balance, which is short of each payment by Razorpay's fee. In a fresh test account a full refund of the only payment therefore fails; the order page then offers admins **Retry refund** once the balance covers it.

Without keys the store works as before, with Cash on Delivery only. Tests never call Razorpay: they use a stand-in (`server/test/fake-razorpay.js`).

## API

| Method | Path                                   | Notes                                                                                                                                                                                                                                                        |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/categories`                      |                                                                                                                                                                                                                                                              |
| GET    | `/api/search/suggest?q=`               | Up to 3 matching `categories`, the 6 best `products` (`slug`, `title`, `brand`, `price`) and the `total` that match                                                                                                                                          |
| GET    | `/api/products`                        | `q`, `category` (slug), `brand` (comma-separated), `minPrice`/`maxPrice` (paise), `rating`, `inStock=1`, `sort`, `page`, `pageSize` ≤48                                                                                                                      |
| GET    | `/api/products/:slug`                  | Full product with images, highlights and category                                                                                                                                                                                                            |
| GET    | `/api/cart`                            | `items=<productId>[.<variantId>]:<qty>,…` (≤20 items, qty ≤10; a product with variants needs one): current prices, stock problems, delivery and total. No login needed                                                                                       |
| POST   | `/api/auth/register`                   | `{ name, email, password }` (≥8 chars); logs in                                                                                                                                                                                                              |
| POST   | `/api/auth/login`                      | `{ email, password }`; sets the `sid` session cookie (httpOnly, 30 days); with two-step login on → `{ user: null, twoStep: true, ticket }` (5 minutes)                                                                                                       |
| POST   | `/api/auth/login/code`                 | `{ ticket, code }` (app code or recovery code) → `{ user, recoveryCodesLeft }` and the session; 5 wrong codes end the ticket (429)                                                                                                                           |
| POST   | `/api/auth/logout`                     | Ends the session                                                                                                                                                                                                                                             |
| POST   | `/api/auth/forgot-password`            | `{ email }` → 204 either way; emails a one-time reset link (1 hour, at most 3 an hour) if the account exists                                                                                                                                                 |
| POST   | `/api/auth/reset-password`             | `{ token, password }`: sets the password, logs out every device, logs this browser in → `{ user }`; with two-step login on → `{ user: null, twoStep: true }` and no session                                                                                  |
| PATCH  | `/api/account`                         | Login. `{ name }` → `{ user }` (the email and role never change here)                                                                                                                                                                                        |
| PUT    | `/api/account/address`                 | Login. `{ address }` (same rules as checkout) → `{ user }`                                                                                                                                                                                                   |
| DELETE | `/api/account/address`                 | Login. Removes the saved address → `{ user }`                                                                                                                                                                                                                |
| POST   | `/api/account/password`                | Login. `{ currentPassword, newPassword }` → 204; wrong current passwords count towards the login lock; logs out other devices                                                                                                                                |
| POST   | `/api/account/two-step/setup`          | Login. `{ password }` → `{ secret, uri }` (for the QR code); takes effect only when confirmed                                                                                                                                                                |
| POST   | `/api/account/two-step/enable`         | Login. `{ code }` (within 15 minutes) → `{ user, recoveryCodes }` (shown once); logs out other devices                                                                                                                                                       |
| POST   | `/api/account/two-step/recovery-codes` | Login. `{ code }` from the app → new `{ recoveryCodes }` (the old ones stop working)                                                                                                                                                                         |
| POST   | `/api/account/two-step/disable`        | Login. `{ password, code }` → `{ user }`                                                                                                                                                                                                                     |
| GET    | `/api/account/email`                   | Login. The email change waiting for confirmation → `{ pendingEmail, expiresAt }` (nulls when none)                                                                                                                                                           |
| POST   | `/api/account/email`                   | Login. `{ newEmail, password }` → 201; emails a confirmation link (24 hours) to the new address; ≤3 an hour; replaces an earlier request                                                                                                                     |
| DELETE | `/api/account/email`                   | Login. Cancels the waiting change → 204                                                                                                                                                                                                                      |
| POST   | `/api/auth/confirm-email`              | `{ token }` from the link (no login needed): changes the email, tells the old address → `{ email, user }` (`user` only when logged in as that account)                                                                                                       |
| PUT    | `/api/stock-alerts/:productId`         | Login. Email me when this sold-out product is back → `{ stockAlert: true }`; 409 if it's in stock; ≤50 per customer; `?variant=<id>` for one sold-out size or colour                                                                                         |
| DELETE | `/api/stock-alerts/:productId`         | Login. Cancels the alert → `{ stockAlert: false }`; `?variant=<id>` for one sold-out size or colour                                                                                                                                                          |
| GET    | `/api/auth/me`                         | `{ user }`, or `{ user: null }` when logged out                                                                                                                                                                                                              |
| POST   | `/api/orders`                          | Login. `{ items, address, expectedTotal, paymentMethod?, couponCode? }` (`cod` default, or `razorpay`); one transaction; 409 if stock or prices changed. Online orders start `awaiting_payment` and include `checkout` (Razorpay order to open)              |
| GET    | `/api/orders`                          | Login. Your orders, newest first                                                                                                                                                                                                                             |
| GET    | `/api/orders/:id`                      | Login. One of your orders                                                                                                                                                                                                                                    |
| POST   | `/api/orders/:id/cancel`               | Login. Cancels an `awaiting_payment` or `placed` order, restores stock, refunds a paid one                                                                                                                                                                   |
| GET    | `/api/payments/options`                | `{ cod, online }`: whether Razorpay is configured                                                                                                                                                                                                            |
| POST   | `/api/orders/:id/pay`                  | Login. Reopens payment for an `awaiting_payment` order → order with `checkout`                                                                                                                                                                               |
| POST   | `/api/orders/:id/payment`              | Login. Checkout's `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }`; verified, then the order is `placed`                                                                                                                                     |
| POST   | `/api/orders/:id/payment/check`        | Login. Asks Razorpay whether the order was paid                                                                                                                                                                                                              |
| POST   | `/api/razorpay/webhook`                | Razorpay only; signed with `RAZORPAY_WEBHOOK_SECRET` (`payment.captured`, `order.paid`)                                                                                                                                                                      |
| GET    | `/api/products/:slug/reviews`          | Visible reviews, newest first, 10 per page (`page`); `viewer` (logged in): your own review and whether you may write one                                                                                                                                     |
| PUT    | `/api/products/:slug/review`           | Login, and a delivered order with the product. `{ rating (1–5), title?, body? }`; creates or replaces your review                                                                                                                                            |
| DELETE | `/api/products/:slug/review`           | Login. Deletes your review                                                                                                                                                                                                                                   |
| GET    | `/api/wishlist`                        | Login. Your saved products (hidden ones left out), newest first                                                                                                                                                                                              |
| PUT    | `/api/wishlist/:productId`             | Login. Saves a product (≤200)                                                                                                                                                                                                                                |
| DELETE | `/api/wishlist/:productId`             | Login. Removes it                                                                                                                                                                                                                                            |
| GET    | `/api/images/:id`                      | An uploaded product photo (cached for a year)                                                                                                                                                                                                                |
| GET    | `/api/admin/request-info`              | Admin. The addresses and proxy headers the server sees for your own request (to check which one is the visitor's IP)                                                                                                                                         |
| GET    | `/api/admin/orders/export`             | Admin. `from`, `to` (`YYYY-MM-DD`, India time, both included, ≤366 days), `status?` → CSV download, one row per order                                                                                                                                        |
| GET    | `/api/orders/:id/returns`              | Login (own order). `{ canReturn, returnableUntil, items: [{ index, title, qty, returnable }], returns }`                                                                                                                                                     |
| POST   | `/api/orders/:id/returns`              | Login. `{ items: [{ index, qty }], reason, note? }` → 201; delivered orders only, within 7 days, each item at most as bought                                                                                                                                 |
| GET    | `/api/admin/returns`                   | Admin. `status?`, `page`; 25 per page, with customers and counts per status                                                                                                                                                                                  |
| POST   | `/api/admin/returns/:id/approve`       | Admin. Puts the stock back; refunds online payments (Razorpay) at once                                                                                                                                                                                       |
| POST   | `/api/admin/returns/:id/decline`       | Admin. `{ reason }` (shown to the customer)                                                                                                                                                                                                                  |
| POST   | `/api/admin/returns/:id/refunded`      | Admin. A Cash on Delivery refund the admin paid; `…/refund` retries a failed online one                                                                                                                                                                      |
| GET    | `/api/delivery`                        | `pincode`: `{ deliverable, minDays, maxDays, area, from?, to? }` (India-time dates)                                                                                                                                                                          |
| GET    | `/api/admin/delivery`                  | Admin. `{ everywhereElse, zones }`; `PUT …/everywhere-else` `{ deliverable, minDays?, maxDays? }`; `POST`/`PUT …/zones[/:id]` `{ prefix, name?, deliverable, minDays?, maxDays? }`; `DELETE …/zones/:id`                                                     |
| GET    | `/api/admin/dashboard`                 | Admin. `days` (`7`, `30` default, `90`): sales totals and the period before, revenue per day (India time), top 5 best sellers, orders to ship, low stock                                                                                                     |
| GET    | `/api/admin/products`                  | Admin. `q`, `category` (id), `status` (`active`, `hidden`, `low`), `page`; 50 per page, hidden products included                                                                                                                                             |
| GET    | `/api/admin/products/:id`              | Admin                                                                                                                                                                                                                                                        |
| POST   | `/api/admin/products`                  | Admin. `{ title, brand, categoryId, price, mrp, stock (or `options: [names]`(1–2) +`variants: [{ values, price, mrp, stock, images? }]`; one option may use `variantName`+`label`), description?, highlights?, images?, active? }`; slug made from the title |
| PATCH  | `/api/admin/products/:id`              | Admin. Any of those fields (`variants` replaces the list, keeping each `id` sent; `variants: []` switches them off); the slug never changes. `active: false` hides it                                                                                        |
| POST   | `/api/admin/images`                    | Admin. Raw JPEG/PNG/WebP body (≤1 MB) → `{ id, url }`                                                                                                                                                                                                        |
| GET    | `/api/admin/categories`                | Admin. With product counts                                                                                                                                                                                                                                   |
| POST   | `/api/admin/categories`                | Admin. `{ name, icon? }`                                                                                                                                                                                                                                     |
| PATCH  | `/api/admin/categories/:id`            | Admin. `{ name?, icon? }`; slug unchanged                                                                                                                                                                                                                    |
| PUT    | `/api/admin/categories/order`          | Admin. `{ ids }`: every category id in display order                                                                                                                                                                                                         |
| GET    | `/api/admin/coupons`                   | Admin. All coupons, newest first, with `usedCount`                                                                                                                                                                                                           |
| POST   | `/api/admin/coupons`                   | Admin. `{ code, type (percent, flat, free_delivery), value, maxDiscount?, minSubtotal?, expiresAt?, usageLimit? }` (paise; whole rupees) → 201; 409 for a used code                                                                                          |
| PATCH  | `/api/admin/coupons/:id`               | Admin. `{ active }`: switch a coupon on or off                                                                                                                                                                                                               |
| DELETE | `/api/admin/categories/:id`            | Admin. Only when no products (hidden ones included) use it                                                                                                                                                                                                   |
| GET    | `/api/admin/orders`                    | Admin. `status`, `q` (order number, customer name or email), `page`; with customer and per-status counts                                                                                                                                                     |
| GET    | `/api/admin/orders/:id`                | Admin                                                                                                                                                                                                                                                        |
| POST   | `/api/admin/orders/:id/status`         | Admin. `{ status }`: `shipped` (from placed), `delivered` (from shipped), `cancelled` (from awaiting payment, placed or shipped; restores stock, refunds if paid); shipping takes an optional `shipment: { courier, trackingNumber, trackingUrl }`           |
| PUT    | `/api/admin/orders/:id/shipment`       | Admin. `{ courier, trackingNumber, trackingUrl }` for a shipped or delivered order (all empty removes it); no email                                                                                                                                          |
| POST   | `/api/admin/orders/:id/refund`         | Admin. Retries a refund that failed                                                                                                                                                                                                                          |
| GET    | `/api/admin/reviews`                   | Admin. `status` (`visible`, `hidden`), `page`; with product, customer and counts                                                                                                                                                                             |
| POST   | `/api/admin/reviews/:id/visibility`    | Admin. `{ hidden }`: hides or shows a review (and takes it out of / back into the rating)                                                                                                                                                                    |

`sort` is one of `relevance` (popularity), `price_asc`, `price_desc`, `newest`, `rating`. All prices are integers in paise.
