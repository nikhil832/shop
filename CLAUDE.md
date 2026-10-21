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

Project skills in `.claude/skills/`: **run-store** (launch and check the app in the browser), **add-feature** (conventions and checklist for new stages), **atlas-troubleshooting** (diagnose the Atlas connection without revealing `server/.env`). Project agent in `.claude/agents/`: **demo-verifier** (read-only tester that runs the demo, checks the UI and reports PASS/FAIL).

## Hooks

`.claude/settings.json` runs these scripts from `.claude/hooks/` (Node, no dependencies):

- **guard-env.mjs** (before Read, Grep, Bash): blocks reading or printing `server/.env` and its copies (`cat`/`head`/plain `grep`/Read tool, `echo $MONGODB_URI`, `console.log(…MONGODB_URI…)`), `git add` of an env file, and any `git commit`/`push` while an env file is staged or tracked. Count-only and masked checks (`grep -c`, `wc`, `test -f`, awk structure listings) stay allowed for the atlas-troubleshooting skill. It is a guardrail for common commands, not a sandbox.
- **confirm-destructive.mjs** (before Bash): asks the user before `npm run seed -- --force` (replaces the Atlas catalog), force pushes (`--force`, `-f`, `--force-with-lease`, `+refspec`) and `git reset --hard`.
- **format-file.mjs** (after Edit, Write): runs the repo's Prettier on the changed file; on a syntax error it reports Prettier's message back instead of failing silently.

If a hook blocks something you need, explain why to the user rather than working around it. Review or disable hooks with `/hooks`.

## Architecture

The store is being built in stages (see README): catalog and accounts/cart/checkout are done; admin, Razorpay payments, reviews/wishlist follow.

**Server** (`server/src/`): `createApp(ctx)` in `app.js` mounts one router per area (`routes/*.js`), each a function of `ctx = { db, client, config }` (MongoDB `Db`, `MongoClient` for sessions/transactions, config). `index.js` loads config (`config.js` reads the gitignored `server/.env`; real env vars win), connects (`db.js` also creates indexes), and serves `client/dist` in production.

- **Money:** every price is an integer number of **paise**, in the database, the API and client state. Format only at display time (`client/src/format.js`). Never store rupees or floats.
- **Validation:** request input goes through zod schemas via `parse()` in `http.js`, which turns the first issue into a 400. Handlers are async (Express 5 forwards rejections) and throw `HttpError(status, msg)`.
- **Ids and URLs:** documents use MongoDB ObjectIds (exposed as hex strings); products and categories are addressed by unique `slug`.
- **Search:** each word must match title or brand (escaped, case-insensitive regex via `escapeRegex`). `relevance` sort is popularity (`rating.count`) for now. The brand facet is computed without the brand filter so other brands stay selectable.
- **Inactive products** (`active: false`) are hidden from listing and detail endpoints.
- **Transactions:** placing and cancelling orders use multi-document transactions (`client.startSession()` + `withTransaction`), which need a replica set. Atlas is one; tests and demo use `MongoMemoryReplSet`. Stock is decremented with the check in the filter (`stock: { $gte: qty }`); a short item throws inside the transaction so nothing changes.
- **Auth:** `sessionMiddleware` (`auth.js`) sets `req.user` from the `sid` cookie on every API request; `requireUser` guards routes. Sessions are stored as a SHA-256 of the token with a TTL index on `expiresAt`. Passwords use `scrypt` (`scrypt$salt$hash`). Roles `user`/`admin`; admin is only granted by `npm run make-admin`, never by the API.
- **Orders:** the cart is client-side; `GET /api/cart` quotes it, and `POST /api/orders` re-reads prices and stock, refusing (409) if the total differs from the `expectedTotal` the customer saw. Orders snapshot item title/price/image, so later product edits don't change them. Delivery rule lives in `orderTotals()` (`routes/orders.js`). Statuses so far: `placed`, `cancelled`. Other users' orders return 404, not 403. The last address used is saved on the user.

**Tests never touch Atlas.** `server/test/helpers.js` starts a fresh `MongoMemoryReplSet` per test file, seeded with the sample catalog (MongoDB version pinned under `config.mongodbMemoryServer` in the root `package.json` to match the Atlas cluster, currently 8.0.34; binaries cache in `~/.cache/mongodb-binaries`). The e2e webServer runs `server/src/demo.js` on port 4100 (in-memory replica set + seed), shared by all spec files, so `shopping.spec.js` registers unique emails and buys only high-stock items the catalog tests don't count. API tests use `t.browser()` from `helpers.js` for a client with its own cookie jar. `demo.js` sets `MONGODB_URI` before `config.js` loads `.env`, and env vars take precedence over the file, so a real URI in `.env` is never used there.

**Seed data** (`server/src/seed.js`): 6 categories and 38 products with fictional brands; 5 products are out of stock. Images are inline SVG data URIs (category icon + brand), so nothing depends on the network. Tests rely on these exact counts.

**Client** (`client/src/`): React 19 + React Router 8 in declarative mode (`BrowserRouter`/`Routes` from `react-router`; there is no `react-router-dom` in v8). Pages in `pages/`, shared pieces in `components/`.

- **URL is the state** for search/filters/sort/page (`useSearchParams`); changing a filter resets `page`. URL prices are rupees; `Search.jsx` converts to paise for the API.
- `useFetch(path)` loads data, aborts stale requests, and derives `loading` instead of setting state in effects (the react-hooks lint rule forbids that). Inputs that must reflect the URL are uncontrolled and remounted with a `key` (header search box, price filter) rather than synced with effects.
- **Cart** (`cart.js`) is a `useSyncExternalStore` over localStorage (`bazaar.cart`, `[{ productId, qty }]`), synced across tabs; it never holds prices. **Login state** (`auth.jsx`): `useAuth().user` is `undefined` while checking, `null` when logged out; pages that need login render `<Navigate to="/login?next=…">`. React Router 8 navigations are transitions, so after clearing the user a page must render its own redirect (see logout in `Orders.jsx`) rather than call `navigate()`.
- Filter checkboxes update after navigation completes, so e2e tests click and then assert `toBeChecked()` instead of using `check()`.
