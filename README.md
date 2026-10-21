# Bazaar

An online store in the style of the big marketplaces: React (Vite) frontend, Express API, MongoDB (Atlas).

Built in stages. Done so far:

1. **Catalog**: categories, search, filters (brand, price, rating, availability), sorting, pagination, product pages.
2. **Accounts, cart and checkout**: sign up and log in, a cart kept in the browser (no login needed to shop), checkout with Cash on Delivery, order history, and cancelling an order that hasn't shipped. Delivery is free from ₹499, otherwise ₹40.

Coming next: admin panel (3), Razorpay payments in test mode (4), reviews and wishlist (5).

## Try it without a database

```bash
npm install
npm run demo     # in-memory MongoDB with sample products; open http://localhost:5173
```

Demo data lives in memory and is gone when you stop it.

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

## API

| Method | Path                     | Notes                                                                                                                                   |
| ------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/categories`        |                                                                                                                                         |
| GET    | `/api/products`          | `q`, `category` (slug), `brand` (comma-separated), `minPrice`/`maxPrice` (paise), `rating`, `inStock=1`, `sort`, `page`, `pageSize` ≤48 |
| GET    | `/api/products/:slug`    | Full product with images, highlights and category                                                                                       |
| GET    | `/api/cart`              | `items=<productId>:<qty>,…` (≤20 items, qty ≤10): current prices, stock problems, delivery and total. No login needed                   |
| POST   | `/api/auth/register`     | `{ name, email, password }` (≥8 chars); logs in                                                                                         |
| POST   | `/api/auth/login`        | `{ email, password }`; sets the `sid` session cookie (httpOnly, 30 days)                                                                |
| POST   | `/api/auth/logout`       | Ends the session                                                                                                                        |
| GET    | `/api/auth/me`           | `{ user }`, or `{ user: null }` when logged out                                                                                         |
| POST   | `/api/orders`            | Login. `{ items, address, expectedTotal }`; COD order in one transaction; 409 if stock or prices changed                                |
| GET    | `/api/orders`            | Login. Your orders, newest first                                                                                                        |
| GET    | `/api/orders/:id`        | Login. One of your orders                                                                                                               |
| POST   | `/api/orders/:id/cancel` | Login. Cancels a `placed` order and restores stock                                                                                      |

`sort` is one of `relevance` (popularity), `price_asc`, `price_desc`, `newest`, `rating`. All prices are integers in paise.
