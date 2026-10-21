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
    razorpay: razorpayConfig(),
  };
  if (!config.mongodbUri) {
    console.error('MONGODB_URI is not set. Add it to server/.env (see server/.env.example), or run `npm run demo`.');
    process.exit(1);
  }
  return config;
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
