// Switches off two-step login for an account whose owner lost both their phone and their recovery codes:
//   npm run reset-two-step -- someone@example.com
// Like make-admin, only for whoever has the database credentials. Logs the account out everywhere, so the next login
// is with the password alone; the owner should turn two-step login on again.
import { connectDb } from './db.js';
import { loadConfig } from './config.js';
import { logActivity } from './activity.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run reset-two-step -- <email of the account>');
  process.exit(1);
}

const config = loadConfig();
const { client, db } = await connectDb(config.mongodbUri, config.mongodbDb);
try {
  const user = await db
    .collection('users')
    .findOneAndUpdate({ email }, { $unset: { totp: '', totpSetup: '' } }, { returnDocument: 'before' });
  if (!user) {
    console.error(`No account with email ${email} in "${config.mongodbDb}".`);
    process.exitCode = 1;
  } else if (!user.totp) {
    console.log(`${email} doesn't have two-step login on; nothing changed.`);
  } else {
    await db.collection('sessions').deleteMany({ userId: user._id });
    await logActivity(db, null, {
      area: 'accounts',
      action: 'Switched off two-step login',
      target: { label: email, path: null },
    });
    console.log(`Two-step login is off for ${email} in "${config.mongodbDb}", and it is logged out everywhere.`);
  }
} finally {
  await client.close();
}
