# Bazaar

An online store in the style of the big marketplaces: React (Vite) frontend, Express API, MongoDB (Atlas).

Built in stages. Done so far:

1. **Catalog**: categories, search, filters (brand, price, rating, availability), sorting, pagination, product pages.

Coming next: accounts, cart and checkout (stage 2), admin panel (3), Razorpay payments in test mode (4), reviews and wishlist (5).

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
```

Env vars (`server/.env` or the environment): `MONGODB_URI` (required except in demo mode), `MONGODB_DB` (default `shop`), `PORT` (default 4000).

## API

| Method | Path                  | Notes                                                                                                                                   |
| ------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/categories`     |                                                                                                                                         |
| GET    | `/api/products`       | `q`, `category` (slug), `brand` (comma-separated), `minPrice`/`maxPrice` (paise), `rating`, `inStock=1`, `sort`, `page`, `pageSize` ≤48 |
| GET    | `/api/products/:slug` | Full product with images, highlights and category                                                                                       |

`sort` is one of `relevance` (popularity), `price_asc`, `price_desc`, `newest`, `rating`. All prices are integers in paise.
