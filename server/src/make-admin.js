// Gives an existing account the admin role: npm run make-admin -- someone@example.com
// The API never grants admin, so this script (run by whoever has the database credentials) is the only way.
import { connectDb } from './db.js';
import { loadConfig } from './config.js';
import { logActivity } from './activity.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run make-admin -- <email of a registered account>');
  process.exit(1);
}

const config = loadConfig();
const { client, db } = await connectDb(config.mongodbUri, config.mongodbDb);
try {
  const { matchedCount } = await db.collection('users').updateOne({ email }, { $set: { role: 'admin' } });
  if (!matchedCount) {
    console.error(`No account with email ${email} in "${config.mongodbDb}". Register it in the store first.`);
    process.exitCode = 1;
  } else {
    await logActivity(db, null, {
      area: 'accounts',
      action: 'Made an admin',
      target: { label: email, path: null },
    });
    console.log(`${email} is now an admin in "${config.mongodbDb}".`);
  }
} finally {
  await client.close();
}
