import { DEFAULT_AI_MODEL } from './ai.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Local settings (e.g. the Atlas connection string) live in server/.env, which is gitignored.
// Variables already set in the environment take precedence over the file.
export function loadConfig() {
  const envFile = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const config = {
    port: Number(process.env.PORT) || 4000,
    mongodbUri: process.env.MONGODB_URI,
    mongodbDb: process.env.MONGODB_DB || 'shop',
    // The header the host's edge sets to the visitor's IP; unset, Express's req.ip is used. On Render (which sets
    // RENDER) it defaults to cf-connecting-ip, since req.ip there is Render's own load balancer: without it, every
    // visitor would share one network for the login limit.
    clientIpHeader:
      process.env.CLIENT_IP_HEADER?.trim().toLowerCase() || (process.env.RENDER ? 'cf-connecting-ip' : null),
    // The database's space, for the storage meter: Atlas's free tier is 512 MB.
    storageLimitMb: Number(process.env.STORAGE_LIMIT_MB) || 512,
    razorpay: razorpayConfig(),
    mail: mailConfig(),
    ai: aiConfig(),
    // Google Search Console's HTML-tag check: the content of its <meta name="google-site-verification">. Only letters,
    // digits, - and _ (what Google's codes use), so it can go into the page as is.
    googleSiteVerification: /^[\w-]{10,100}$/.test(process.env.GOOGLE_SITE_VERIFICATION?.trim() ?? '')
      ? process.env.GOOGLE_SITE_VERIFICATION.trim()
      : null,
  };
  if (!config.mongodbUri) {
    console.error('MONGODB_URI is not set. Add it to server/.env (see server/.env.example), or run `npm run demo`.');
    process.exit(1);
  }
  return config;
}

// "Write for me" in the admin product form uses Claude's API when ANTHROPIC_API_KEY is set (each draft costs a little);
// AI_MODEL picks the model. Without a key the button isn't shown. Messages never include the key.
function aiConfig() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  const model = process.env.AI_MODEL?.trim() || DEFAULT_AI_MODEL;
  if (!/^claude-[a-z0-9-]+$/.test(model)) {
    console.error('AI_MODEL must be a Claude model id, like claude-opus-5-5 or claude-haiku-5-5.');
    process.exit(1);
  }
  // Overridden only by the tests, which point it at a stand-in server.
  return { apiKey, model, apiUrl: process.env.ANTHROPIC_API_URL || null };
}

// Order emails go out through Brevo when BREVO_API_KEY is set; otherwise they are only printed in the server log.
// PUBLIC_URL is the site address the emails link to. Messages never include the key. New-order alerts go to ADMIN_EMAIL
// (one address or several, comma-separated) or, when it's not set, to every admin account.
function mailConfig() {
  const apiKey = process.env.BREVO_API_KEY?.trim() || null;
  const from = process.env.MAIL_FROM?.trim() || null;
  if (apiKey && !from) {
    console.error('Set MAIL_FROM (the sender address you verified in Brevo) along with BREVO_API_KEY.');
    process.exit(1);
  }
  return {
    apiKey,
    from,
    fromName: process.env.MAIL_FROM_NAME?.trim() || 'Bazaar',
    adminEmails: (process.env.ADMIN_EMAIL ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean),
    publicUrl: (process.env.PUBLIC_URL?.trim() || 'http://localhost:5173').replace(/\/+$/, ''),
    // Overridden only by the tests, which point it at a stand-in server.
    apiUrl: process.env.BREVO_API_URL || 'https://api.brevo.com',
  };
}

// Online payments are on only when both keys are set, and only with test-mode keys (this store never takes real money).
// Messages never include the key values.
function razorpayConfig() {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId && !keySecret) return null;
  if (!keyId || !keySecret) {
    console.error(
      'Set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in server/.env, or neither (Cash on Delivery only).',
    );
    process.exit(1);
  }
  if (!keyId.startsWith('rzp_test_')) {
    console.error('RAZORPAY_KEY_ID must be a test-mode key (starting with rzp_test_). Live keys are not allowed here.');
    process.exit(1);
  }
  return {
    keyId,
    keySecret,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || null,
    // Overridden only by the tests, which point it at a stand-in server.
    apiUrl: process.env.RAZORPAY_API_URL || 'https://api.razorpay.com',
  };
}
