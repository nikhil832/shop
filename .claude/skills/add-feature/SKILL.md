---
name: add-feature
description: Build a new feature or stage of the Bazaar store (e.g. accounts, cart, checkout, orders, admin, Razorpay payments, reviews, wishlist) following this repo's conventions for API routes, validation, money, transactions, React pages, tests, docs and commits. Use when adding or changing an API area, a page, or a database collection in this repo.
---

# Add a feature to the store

Read `CLAUDE.md` first for the architecture. This skill is the checklist for doing a change the way the existing code does it.

## Stages

Built so far: **1. Catalog** (categories, search, filters, sorting, pagination, product pages) and **2. Accounts, cart, checkout (COD), order history** (with customer cancel while `placed`, free delivery from ₹499 else ₹40, address remembered on the account, cart in the browser only), and **3. Admin panel** (orders placed → shipped → delivered with admin cancel; products with uploaded images stored in MongoDB, hide instead of delete; categories), **4. Razorpay payments** (test mode only; stock reserved 30 min while paying; server-side verification + webhook; automatic refunds on cancel), and **5. Reviews & wishlist** (buyers with a delivered order only; sample ratings kept and added to; admins hide, never delete; wishlist saved in the account). After those: deployed on Render (free plan, `render.yaml`; every push to `main` goes live) and **6. Order emails** through Brevo (confirmed, shipped, delivered, cancelled). Then **7. Password reset by email** (one-time link, 1 hour). Then **8. Search ranking** (category/highlight matches, plurals, synonyms, scored relevance). Then login protection, then **10. Account page** (name, saved address, change password), then **11. Back-in-stock alerts**, then **12. Search suggestions**, then **13. Coupon codes**, then **14. Sales dashboard**, then **15. New-order alerts** for admins, then **16. Unused upload cleanup**, then **17. Login limit per network**, then **18. Change email**, then **19. Printable invoices**, then **20. Export orders**. What's next is in `ROADMAP.md`; update it (move the idea to Done with the commit) as part of the docs step. Ask the user what comes next.

Planned, in this order (the user chose all of them; the user pauses between stages, so confirm before starting one):

2. Accounts, cart, checkout (Cash on Delivery), order history
3. Admin panel: products, categories, stock, order status
4. Razorpay payments in **test mode**
5. Reviews & ratings, wishlist

Design notes from the planned stages (all now built; see `CLAUDE.md` for how each works):

- **Auth (built in stage 2):** email + password hashed with `node:crypto` `scrypt` (no native modules); random session token in an httpOnly, `SameSite=Lax` cookie, stored in a `sessions` collection so it can be revoked. Roles `user`/`admin`; the first admin is created by a CLI script, never via the API.
- **Cart (built in stage 2):** kept in the browser for guests, so browsing needs no login. Checkout requires login, and the server re-reads prices and stock instead of trusting the client.
- **Placing an order (built in stage 2):** one transaction that decrements stock only where `stock >= qty`, snapshots item prices into the order, and creates the order. If any item is short, nothing changes.
- **Razorpay (built in stage 4):** keys from `server/.env` (`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`, test keys only). Verify the payment signature with HMAC on the server. Without keys, only COD is offered. Tests stub the Razorpay HTTP calls.
- **Reviews (built in stage 5):** one per user per product, and only from customers with a delivered order containing it (the user chose buyers-only over a "verified purchase" badge); `rating.avg`/`rating.count` on the product kept up to date in the same transaction.

## Server

1. **One router per area:** `server/src/routes/<area>.js` exports `<area>Router(ctx)` where `ctx = { db, client, config }`, like `catalogRouter`. Mount it in `app.js` **before** the JSON 404 handler.
2. **Validate every input** (body, query, params) with a zod schema and `parse()` from `http.js`, which turns the first issue into a 400. Use `parseObjectId()` for ids and `throw new HttpError(status, msg)` for other failures. Handlers are `async`; Express 5 forwards rejections.
3. **Only write fields the schema returned.** Never spread `req.body` into a database write.
4. **Money is integer paise** in the database, API and client state. Compute totals in paise and format only for display (`client/src/format.js`).
5. **Transactions:** for anything that changes stock, orders or payments together:
   ```js
   const session = ctx.client.startSession();
   try {
     await session.withTransaction(async () => {
       // pass { session } to EVERY operation inside
     });
   } finally {
     await session.endSession();
   }
   ```
   Make the stock check part of the update filter (`{ _id, stock: { $gte: qty } }`) and check `modifiedCount`; don't read-then-write.
6. **Indexes** go in `ensureIndexes()` in `db.js` (unique ones for emails, slugs, one-review-per-user, etc.).
7. **Seed data** (`seed.js`) is what tests count on: 6 categories, 38 products, 5 out of stock. If you change it, update the counts in `server/test/catalog.test.js` and `e2e/catalog.spec.js`.
8. **Secrets** (session secret, Razorpay keys) come from `server/.env` via `config.js`; add a placeholder line to `server/.env.example`. Never hard-code or log them.

## Client

1. Add the page in `client/src/pages/` and its route in `main.jsx`. Import routing from `react-router` (v8 has no `react-router-dom`).
2. Load data with `useFetch(path)`. Call `request()` from `api.js` directly for mutations.
3. **Don't call setState inside effects** (the react-hooks lint rule fails the build). Derive values instead, or remount uncontrolled inputs with a `key` (see `Header.jsx`, `PriceFilter`).
4. Put shareable state (filters, sort, page) in the URL; keep transient UI state in components.
5. Use the CSS tokens in `styles.css` (`--surface`, `--accent`, …) so dark mode keeps working, and check phone width (the layout switches at 800px).

## Tests

- **API:** `server/test/<area>.test.js` using `startTestServer()` from `helpers.js`. Each file gets its own fresh in-memory replica set with the sample catalog, and `t.call(method, path, body)` returns `{ status, body }`. Cover the happy path, every validation error, permission checks, and for transactions the "nothing changed on failure" case: assert stock and orders after a failed checkout.
- **Browser:** `e2e/<area>.spec.js`. Tests share one demo server on port 4100 and run with one worker, so create your own data (unique emails, etc.) rather than relying on test order. Known gotchas:
  - URL-driven checkboxes: click, then `expect(...).toBeChecked()` (see `tick()` in `catalog.spec.js`); `check()` reads too early.
  - `<input type="number">` has role `spinbutton`; use `getByLabel`.
- Run everything:
  ```bash
  npm run lint && npx prettier --check . && npm test && npm run test:e2e
  ```
  Then use the **run-store** skill to look at the change in demo mode, at desktop and phone width.
- Never run tests or experiments against Atlas. The demo and test servers set `MONGODB_URI` themselves, and environment variables take precedence over `server/.env`.

## Docs and commit

1. Update `README.md`: the "Done so far" stage list and the API table.
2. Update `CLAUDE.md` with anything non-obvious a future session needs (new collections, invariants, gotchas). Don't list files.
3. `git status --short`: make sure no `server/.env*` file is staged (the repo is public).
4. Commit with a message saying what the stage adds; the repo's git config already uses the user's GitHub noreply email. End the message with the co-author line from the session's attribution instructions.
5. Push to `origin main` only when the user asks, then watch CI:
   ```bash
   gh run watch "$(gh run list --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
   ```
   A new run can take a few seconds to appear after the push; wait for it rather than reporting "not found".
