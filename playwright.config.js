import { defineConfig } from '@playwright/test';

const PORT = 4100;
const FAKE_RAZORPAY_PORT = 4101;

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // System Chrome (preinstalled on GitHub runners), so no browser download is needed.
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // A stand-in for Razorpay's API, so payments are tested without the real service.
      command: 'node server/test/fake-razorpay.js',
      env: { FAKE_RAZORPAY_PORT: String(FAKE_RAZORPAY_PORT) },
      port: FAKE_RAZORPAY_PORT,
      reuseExistingServer: false,
    },
    {
      // Production build + demo mode (in-memory MongoDB with the sample catalog) on a dedicated port:
      // never touches real data or a running dev server. Env vars set here take precedence over server/.env,
      // so real Razorpay keys there are never used: these are the stand-in's fake test keys.
      command: 'npm run build && node server/src/demo.js',
      env: {
        PORT: String(PORT),
        RAZORPAY_KEY_ID: 'rzp_test_fakekey000000',
        RAZORPAY_KEY_SECRET: 'fake_secret_for_tests',
        RAZORPAY_WEBHOOK_SECRET: 'fake_webhook_secret',
        RAZORPAY_API_URL: `http://localhost:${FAKE_RAZORPAY_PORT}`,
      },
      url: `http://localhost:${PORT}/api/categories`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
