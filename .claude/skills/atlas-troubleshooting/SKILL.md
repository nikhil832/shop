---
name: atlas-troubleshooting
description: Set up or diagnose the store's MongoDB Atlas connection (server/.env, MONGODB_URI) without ever revealing the connection string. Use when `npm run dev`, `npm start` or `npm run seed` fails to connect, when the user is creating server/.env, when they ask where the connection string comes from, or before work that depends on Atlas (e.g. transactions for orders).
---

# Atlas connection troubleshooting

## Rule zero: never reveal the connection string

`server/.env` holds the Atlas password and the repo is **public**.

- Never `cat`, `Read`, `head`, `grep` (without `-c`) or otherwise print `server/.env` or any copy of it.
- Inspect it only with counts and masked structure (below). Pipe any command output that might echo the URI through `sed -E 's#mongodb(\+srv)?://[^ ]*#<hidden>#g'`.
- Don't ask the user to paste the string into chat. If they do, tell them to rotate the database user's password in Atlas.
- `.gitignore` ignores every `server/.env*` except `server/.env.example`. Before any commit or push, confirm with `git status --short` that no env file is staged.

## 1. Is the file there, and is it a file?

```bash
f=server/.env
if [ -f $f ]; then echo "file, $(wc -c < $f | tr -d ' ') bytes"; elif [ -d $f ]; then echo "FOLDER, not a file"; else echo missing; fi
find server -maxdepth 1 -name ".env*"     # names only
```

Seen before:

- **A folder named `.env`** containing a copy of `.env.example`. The app needs a file. The user should move the content into a file and remove the folder.
- **`.env.rtf`**: saved from TextEdit as rich text. The app can't read it. Convert without displaying it, then ask the user to delete the `.rtf` copy:
  ```bash
  textutil -convert txt -output server/.env server/.env.rtf
  ```
  Recommend `nano server/.env` over TextEdit for future edits.

## 2. Check the format without printing values

```bash
cd server
echo "URI lines:            $(grep -cE '^MONGODB_URI=mongodb(\+srv)?://' .env)"      # want 1
echo "placeholders left:    $(grep -cE '<(db_)?password>|<user>|<cluster>' .env)"     # want 0
echo "non-ASCII chars:      $(LC_ALL=C grep -c '[^ -~]' .env)"                        # want 0 (smart quotes)
echo "stray spaces:         $(grep -cE '^MONGODB_URI *= +| +$|^MONGODB_URI=[^ ]* [^ ]' .env)"   # want 0
awk '{ if ($0 ~ /^[[:space:]]*$/) print NR": (blank)"; else if ($0 ~ /^#/) print NR": (comment)";
       else if ($0 ~ /^[A-Z_]+=/) { split($0,a,"="); print NR": "a[1]"=…" } else print NR": (other text, " length($0) " chars)" }' .env
```

In the structure listing, a short "other text" line right after `MONGODB_URI=…` (e.g. 27 chars, the length of `w=majority&appName=Cluster0`) suggests the string was split across two lines. Lines that aren't `KEY=value` are ignored by the parser, but may contain the user's notes or password. Tell the user, don't print them.

## 3. Test the connection

```bash
npm run seed 2>&1 | grep -v '^>' | sed -E 's#mongodb(\+srv)?://[^ ]*#<hidden>#g' | tail -5
```

When products already exist this only connects and counts ("Products already exist; nothing seeded"), so it's a safe check. **Never add `--force` unless the user explicitly asks**: it replaces all products and categories.

| Error contains                              | Cause                                                    | What the user should do                                                                       |
| ------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `bad auth`, `Authentication failed`         | Wrong database username/password (not their Atlas login) | Recheck Database Access in Atlas; make sure `<db_password>` was replaced, including the `< >` |
| `Server selection timed out`, `ETIMEDOUT`   | Their IP isn't allowlisted (home IPs change)             | Atlas → Network Access → Add Current IP Address                                               |
| `querySrv ENOTFOUND`, `ECONNREFUSED` on SRV | DNS can't resolve the `mongodb+srv` host                 | Check the copied hostname; try another network/DNS                                            |
| `MONGODB_URI is not set`                    | No `server/.env`, or the key is misspelled               | Step 1–2                                                                                      |
| Special-character errors / `URI malformed`  | Password contains `@ : / ? # %`                          | Regenerate a password without them, or URL-encode it                                          |

## 4. Check transactions and server version

Orders rely on multi-document transactions, and tests pin MongoDB to the Atlas version. This script writes one document to a temporary collection and drops it:

```bash
cd server && node --input-type=module -e "
import { MongoClient } from 'mongodb';
process.loadEnvFile('.env');
const client = new MongoClient(process.env.MONGODB_URI);
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'shop');
  const hello = await db.admin().command({ hello: 1 });
  console.log('replica set:', hello.setName ? 'yes' : 'no', '| version:', (await db.admin().command({ buildInfo: 1 })).version);
  const col = db.collection('_transaction_check');
  const s = client.startSession();
  await s.withTransaction(async () => { await col.insertOne({ at: new Date() }, { session: s }); });
  await s.endSession();
  await col.drop();
  console.log('transactions: ok');
} catch (e) { console.log('FAILED:', e.codeName || e.name, '-', e.message.replace(/mongodb(\+srv)?:\/\/\S+/g, '<hidden>')); }
finally { await client.close(); }"
```

If the version differs from `config.mongodbMemoryServer.version` in the root `package.json` (8.0.34 when this was written), update the pin so tests run on the same version, run `npm test` (it downloads the binary once into `~/.cache/mongodb-binaries`), and mention it in `CLAUDE.md`.

## Where the connection string comes from (for the user)

Atlas → **Database/Clusters** → **Connect** → **Drivers** → **Node.js** → copy `mongodb+srv://<user>:<db_password>@<cluster>.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0` and replace `<db_password>`. Then `cp server/.env.example server/.env`, put it on the `MONGODB_URI=` line as one unbroken line, and run step 3.
