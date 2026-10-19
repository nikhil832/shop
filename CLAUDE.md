# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

npm workspaces monorepo (`server`, `client`). Run everything from the repo root. Node >= 22.12 is enforced (`engine-strict`); CI uses Node 24.

```bash
npm run demo           # API on :4000 against an in-memory MongoDB with sample data + Vite on :5173
npm run dev            # same, but against MONGODB_URI from server/.env (Atlas)
npm test               # server API tests (node:test, test/**/*.test.js)
npm run test:e2e       # Playwright browser tests (e2e/)
npm run lint           # ESLint
npm run format:check   # Prettier check; CI fails on unformatted files
npm run seed           # load the sample catalog into MONGODB_URI (skips if products exist; -- --force replaces)
```

Single tests: `npm test -w server -- --test-name-pattern="sorts by price"`, `npx playwright test -g "paginates"`.

CI runs lint → format:check → test → build → test:e2e. Prettier: single quotes, 120 columns.

The API uses port **4000** (not 3001) so it can run next to the user's task-manager project.

## Architecture

The store is being built in stages (see README): catalog is done; accounts/cart/checkout, admin, Razorpay payments, reviews/wishlist follow.

**Server** (`server/src/`): `createApp(ctx)` in `app.js` mounts one router per area (`routes/*.js`), each a function of `ctx = { db, client, config }` (MongoDB `Db`, `MongoClient` for sessions/transactions, config). `index.js` loads config (`config.js` reads the gitignored `server/.env`; real env vars win), connects (`db.js` also creates indexes), and serves `client/dist` in production.

- **Money:** every price is an integer number of **paise**, in the database, the API and client state. Format only at display time (`client/src/format.js`). Never store rupees or floats.
- **Validation:** request input goes through zod schemas via `parse()` in `http.js`, which turns the first issue into a 400. Handlers are async (Express 5 forwards rejections) and throw `HttpError(status, msg)`.
- **Ids and URLs:** documents use MongoDB ObjectIds (exposed as hex strings); products and categories are addressed by unique `slug`.
- **Search:** each word must match title or brand (escaped, case-insensitive regex via `escapeRegex`). `relevance` sort is popularity (`rating.count`) for now. The brand facet is computed without the brand filter so other brands stay selectable.
- **Inactive products** (`active: false`) are hidden from listing and detail endpoints.
- **Transactions:** order placement will use multi-document transactions, which need a replica set. Atlas is one; tests and demo use `MongoMemoryReplSet`.

**Tests never touch Atlas.** `server/test/helpers.js` starts a fresh `MongoMemoryReplSet` per test file, seeded with the sample catalog (MongoDB version pinned under `config.mongodbMemoryServer` in the root `package.json`). The e2e webServer runs `server/src/demo.js` on port 4100 (in-memory replica set + seed). `demo.js` sets `MONGODB_URI` before `config.js` loads `.env`, and env vars take precedence over the file, so a real URI in `.env` is never used there.

**Seed data** (`server/src/seed.js`): 6 categories and 38 products with fictional brands; 5 products are out of stock. Images are inline SVG data URIs (category icon + brand), so nothing depends on the network. Tests rely on these exact counts.

**Client** (`client/src/`): React 19 + React Router 8 in declarative mode (`BrowserRouter`/`Routes` from `react-router`; there is no `react-router-dom` in v8). Pages in `pages/`, shared pieces in `components/`.

- **URL is the state** for search/filters/sort/page (`useSearchParams`); changing a filter resets `page`. URL prices are rupees; `Search.jsx` converts to paise for the API.
- `useFetch(path)` loads data, aborts stale requests, and derives `loading` instead of setting state in effects (the react-hooks lint rule forbids that). Inputs that must reflect the URL are uncontrolled and remounted with a `key` (header search box, price filter) rather than synced with effects.
- Filter checkboxes update after navigation completes, so e2e tests click and then assert `toBeChecked()` instead of using `check()`.
