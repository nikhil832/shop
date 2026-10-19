---
name: run-store
description: Launch the Bazaar store locally (demo mode on an in-memory MongoDB, or Atlas mode from server/.env), confirm it is serving, check pages in a real browser at desktop and phone width, and shut everything down cleanly. Use when asked to run, start, demo, preview, screenshot or "live check" the store, or to confirm a change works in the real app rather than only in tests.
---

# Run and verify the store

## 1. Check ports before starting

The store's API uses **4000**, Vite uses **5173** (or the next free port), and the e2e tests use **4100**. The user often has another project (a task manager) running on **3001/5173** at the same time.

```bash
lsof -iTCP:4000 -iTCP:4100 -iTCP:5173 -iTCP:5174 -sTCP:LISTEN -n -P
```

For anything already listening, find out what it is before doing anything about it:

```bash
lsof -p <pid> | grep cwd    # which project it belongs to
```

- A leftover store process (cwd inside this repo, e.g. an old `src/demo.js`) can be stopped (see step 5).
- **Never stop processes from other projects.** If 5173 is taken, that's fine: Vite picks the next port and prints it.
- `curl localhost:3001` reaches the other project, not this store. Always use port 4000 for the API.

## 2. Start it (in the background)

Pick the mode:

| Mode                      | Command                      | Data                                                               | Needs                                                             |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Demo (default for checks) | `npm run demo`               | In-memory replica set seeded with the sample catalog; lost on stop | Nothing                                                           |
| Atlas                     | `npm run dev`                | The user's real Atlas database                                     | `server/.env` (see the `atlas-troubleshooting` skill if it fails) |
| Production build          | `npm run build && npm start` | Atlas; one server on :4000 serves UI + API                         | `server/.env`                                                     |

Prefer **demo mode** for verifying changes: it can't damage real data and always has the same 38 products. Use Atlas mode only when the user asks to see their real data. Never write test data to Atlas.

Run it with `run_in_background`, then wait for both ready lines in its output instead of sleeping:

- `[api] API listening on http://localhost:4000 (database "demo")` (or `"shop"` for Atlas)
- `[web]   ➜  Local:   http://localhost:<port>/`: **use this port**, it's often 5174.

If the API line never appears, read the output: `MONGODB_URI is not set` means Atlas mode without `server/.env`; `EADDRINUSE` means step 1 was skipped.

## 3. Smoke-test the API

```bash
curl -s localhost:4000/api/categories | head -c 200
curl -s "localhost:4000/api/products?pageSize=1" | head -c 200
```

Expect JSON with categories and a product. `{"error":"Not found"}` on these routes means you are talking to some other server (see step 1).

## 4. Check it in the browser

Use the Playwright MCP tools against the **Vite URL** from step 2.

1. `browser_navigate` to `/` and `browser_wait_for` the text **Top rated**. Product images are inline SVGs, so they render immediately.
2. Exercise what changed: e.g. `/search?category=mobiles`, click a brand checkbox, open a product `/p/<slug>`.
3. `browser_take_screenshot` and **look at it**. A blank or half-styled page is a failure, not a pass.
4. Repeat at phone width: `browser_resize` to 390×844, screenshot, then resize back to 1200×660.
5. `browser_console_messages` with level `error`: there should be none.

Things that have gone wrong before and how they looked:

- **Stale page after an edit:** Vite reloads on save, but a page loaded at the same moment can miss it. Navigate again before concluding a fix didn't work. To confirm what Vite serves: `curl -s localhost:<vite-port>/src/<file> | grep <new-text>`.
- **Filter checkboxes update after navigation finishes:** wait for the result count or URL to change rather than reading the checkbox right after the click.
- **Screenshots** can only be saved inside the repo (the MCP's allowed roots); don't pass a path outside it. Its output folder `.playwright-mcp/` is gitignored.

## 5. Shut down

Stop only this repo's processes. The other project also runs a `node src/index.js`, so match on each process's working folder, not just its command line:

```bash
root=$(git rev-parse --show-toplevel)
for pid in $(pgrep -f "src/(index|demo)\.js"); do
  [ "$(lsof -a -p "$pid" -d cwd -Fn | sed -n 's/^n//p')" = "$root/server" ] && kill "$pid"
done
pkill -f "$root/node_modules/.bin/vite"
sleep 2; pgrep -fl "mongod-arm64|mongo_killer" || echo "all stopped"
```

The in-memory `mongod` is stopped by mongodb-memory-server's watchdog (`mongo_killer.js`) a moment after its parent exits. If one is still listed after a few seconds and its parent is gone, stop it by PID.

A background task that you stopped is reported as "failed" (exit code 1, 143 or 144). That's the stop, not a crash. Say so when reporting.

## Reporting

Say which mode you used, which URL, what you clicked, and what you saw (with screenshots). Mention anything that looked off, even if it's unrelated to the change.
