# Bazaar

An online store in the style of the big marketplaces: React (Vite) frontend, Express API, MongoDB (Atlas).

Built in stages. Done so far:

1. **Catalog**: categories, search, filters (brand, price, rating, availability), sorting, pagination, product pages.
2. **Accounts, cart and checkout**: sign up and log in, a cart kept in the browser (no login needed to shop), checkout with Cash on Delivery, order history, and cancelling an order that hasn't shipped. Delivery is free from ₹499, otherwise ₹40.

3. **Admin panel** (`/admin`, admins only): orders (search, filter by status, mark shipped → delivered, cancel with stock returned), products (add and edit with photo uploads, quick stock edits, hide/show), and categories (add, rename, reorder, delete when empty).

4. **Online payments** with Razorpay in **test mode**: UPI, cards, netbanking and wallets next to Cash on Delivery. Stock is held for 30 minutes while the customer pays; unpaid orders then expire. Payments are verified on the server (signature + Razorpay API, and a webhook as backup); cancelling a paid order refunds it automatically.

5. **Reviews and wishlist**: customers rate and review products they've received (one review each, which they can edit or delete); new reviews are added to the sample ratings. Admins can hide a review, which also takes it out of the rating. A wishlist kept in the account, with a Wishlist page next to My orders.

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
```

Env vars (`server/.env` or the environment): `MONGODB_URI` (required except in demo mode), `MONGODB_DB` (default `shop`), `PORT` (default 4000).

### Razorpay (optional, test mode only)

1. In the Razorpay Dashboard, switch to **Test Mode**, then Account & Settings → API keys → generate a key.
2. Add `RAZORPAY_KEY_ID` (starts with `rzp_test_`) and `RAZORPAY_KEY_SECRET` to `server/.env`. Live keys are refused at startup.
3. Restart `npm run dev` (or `npm run demo`, which also reads them): the server prints "Online payments: Razorpay test mode" and checkout offers "Pay online". Pay with Razorpay's [test cards or UPI IDs](https://razorpay.com/docs/payments/payments/test-card-details/); no real money moves.
4. Optional webhook (needs a public URL): Dashboard → Webhooks → `https://<your-site>/api/razorpay/webhook`, events `payment.captured` and `order.paid`, and put its secret in `RAZORPAY_WEBHOOK_SECRET`.

Refunds are paid from your Razorpay balance, which is short of each payment by Razorpay's fee. In a fresh test account a full refund of the only payment therefore fails; the order page then offers admins **Retry refund** once the balance covers it.

Without keys the store works as before, with Cash on Delivery only. Tests never call Razorpay: they use a stand-in (`server/test/fake-razorpay.js`).

## API

| Method | Path                                | Notes                                                                                                                                                                                                                              |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/categories`                   |                                                                                                                                                                                                                                    |
| GET    | `/api/products`                     | `q`, `category` (slug), `brand` (comma-separated), `minPrice`/`maxPrice` (paise), `rating`, `inStock=1`, `sort`, `page`, `pageSize` ≤48                                                                                            |
| GET    | `/api/products/:slug`               | Full product with images, highlights and category                                                                                                                                                                                  |
| GET    | `/api/cart`                         | `items=<productId>:<qty>,…` (≤20 items, qty ≤10): current prices, stock problems, delivery and total. No login needed                                                                                                              |
| POST   | `/api/auth/register`                | `{ name, email, password }` (≥8 chars); logs in                                                                                                                                                                                    |
| POST   | `/api/auth/login`                   | `{ email, password }`; sets the `sid` session cookie (httpOnly, 30 days)                                                                                                                                                           |
| POST   | `/api/auth/logout`                  | Ends the session                                                                                                                                                                                                                   |
| GET    | `/api/auth/me`                      | `{ user }`, or `{ user: null }` when logged out                                                                                                                                                                                    |
| POST   | `/api/orders`                       | Login. `{ items, address, expectedTotal, paymentMethod? }` (`cod` default, or `razorpay`); one transaction; 409 if stock or prices changed. Online orders start `awaiting_payment` and include `checkout` (Razorpay order to open) |
| GET    | `/api/orders`                       | Login. Your orders, newest first                                                                                                                                                                                                   |
| GET    | `/api/orders/:id`                   | Login. One of your orders                                                                                                                                                                                                          |
| POST   | `/api/orders/:id/cancel`            | Login. Cancels an `awaiting_payment` or `placed` order, restores stock, refunds a paid one                                                                                                                                         |
| GET    | `/api/payments/options`             | `{ cod, online }`: whether Razorpay is configured                                                                                                                                                                                  |
| POST   | `/api/orders/:id/pay`               | Login. Reopens payment for an `awaiting_payment` order → order with `checkout`                                                                                                                                                     |
| POST   | `/api/orders/:id/payment`           | Login. Checkout's `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }`; verified, then the order is `placed`                                                                                                           |
| POST   | `/api/orders/:id/payment/check`     | Login. Asks Razorpay whether the order was paid                                                                                                                                                                                    |
| POST   | `/api/razorpay/webhook`             | Razorpay only; signed with `RAZORPAY_WEBHOOK_SECRET` (`payment.captured`, `order.paid`)                                                                                                                                            |
| GET    | `/api/products/:slug/reviews`       | Visible reviews, newest first, 10 per page (`page`); `viewer` (logged in): your own review and whether you may write one                                                                                                           |
| PUT    | `/api/products/:slug/review`        | Login, and a delivered order with the product. `{ rating (1–5), title?, body? }`; creates or replaces your review                                                                                                                  |
| DELETE | `/api/products/:slug/review`        | Login. Deletes your review                                                                                                                                                                                                         |
| GET    | `/api/wishlist`                     | Login. Your saved products (hidden ones left out), newest first                                                                                                                                                                    |
| PUT    | `/api/wishlist/:productId`          | Login. Saves a product (≤200)                                                                                                                                                                                                      |
| DELETE | `/api/wishlist/:productId`          | Login. Removes it                                                                                                                                                                                                                  |
| GET    | `/api/images/:id`                   | An uploaded product photo (cached for a year)                                                                                                                                                                                      |
| GET    | `/api/admin/products`               | Admin. `q`, `category` (id), `status` (`active`, `hidden`, `low`), `page`; 50 per page, hidden products included                                                                                                                   |
| GET    | `/api/admin/products/:id`           | Admin                                                                                                                                                                                                                              |
| POST   | `/api/admin/products`               | Admin. `{ title, brand, categoryId, price, mrp, stock, description?, highlights?, images?, active? }`; slug made from the title                                                                                                    |
| PATCH  | `/api/admin/products/:id`           | Admin. Any of those fields; the slug never changes. `active: false` hides it                                                                                                                                                       |
| POST   | `/api/admin/images`                 | Admin. Raw JPEG/PNG/WebP body (≤1 MB) → `{ id, url }`                                                                                                                                                                              |
| GET    | `/api/admin/categories`             | Admin. With product counts                                                                                                                                                                                                         |
| POST   | `/api/admin/categories`             | Admin. `{ name, icon? }`                                                                                                                                                                                                           |
| PATCH  | `/api/admin/categories/:id`         | Admin. `{ name?, icon? }`; slug unchanged                                                                                                                                                                                          |
| PUT    | `/api/admin/categories/order`       | Admin. `{ ids }`: every category id in display order                                                                                                                                                                               |
| DELETE | `/api/admin/categories/:id`         | Admin. Only when no products (hidden ones included) use it                                                                                                                                                                         |
| GET    | `/api/admin/orders`                 | Admin. `status`, `q` (order number, customer name or email), `page`; with customer and per-status counts                                                                                                                           |
| GET    | `/api/admin/orders/:id`             | Admin                                                                                                                                                                                                                              |
| POST   | `/api/admin/orders/:id/status`      | Admin. `{ status }`: `shipped` (from placed), `delivered` (from shipped), `cancelled` (from awaiting payment, placed or shipped; restores stock, refunds if paid)                                                                  |
| POST   | `/api/admin/orders/:id/refund`      | Admin. Retries a refund that failed                                                                                                                                                                                                |
| GET    | `/api/admin/reviews`                | Admin. `status` (`visible`, `hidden`), `page`; with product, customer and counts                                                                                                                                                   |
| POST   | `/api/admin/reviews/:id/visibility` | Admin. `{ hidden }`: hides or shows a review (and takes it out of / back into the rating)                                                                                                                                          |

`sort` is one of `relevance` (popularity), `price_asc`, `price_desc`, `newest`, `rating`. All prices are integers in paise.
