import { defineConfig } from '@playwright/test';

const PORT = 4100;

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
  webServer: {
    // Production build + demo mode (in-memory MongoDB with the sample catalog) on a dedicated port:
    // never touches real data or a running dev server. Env vars set here take precedence over server/.env.
    command: 'npm run build && node server/src/demo.js',
    env: { PORT: String(PORT) },
    url: `http://localhost:${PORT}/api/categories`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
