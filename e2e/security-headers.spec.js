import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Everything the security policy (server/src/securityHeaders.js) blocks on a page, collected from the browser.
async function watchViolations(page) {
  await page.addInitScript(() => {
    globalThis.violations = [];
    globalThis.document.addEventListener('securitypolicyviolation', (e) =>
      globalThis.violations.push(`${e.effectiveDirective} ${e.blockedURI}`),
    );
  });
  return () => page.evaluate(() => globalThis.violations);
}

test('the store works under its security policy: nothing on its pages is blocked', async ({ page }) => {
  const response = await page.goto('/');
  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(response.headers()['x-frame-options']).toBe('DENY');

  const violations = await watchViolations(page);
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  for (const [path, ready] of [
    ['/', 'Top rated'],
    ['/search?q=shoes', 'Stride Running Shoes'],
    ['/p/ziva-women-handbag', 'Add to cart'],
    // The dashboard's chart bars are sized with style props.
    ['/admin', 'Sales'],
    ['/account', 'Two-step login'],
  ]) {
    await page.goto(path);
    await expect(page.getByText(ready).first()).toBeVisible();
    expect(await violations(), path).toEqual([]);
  }
});

test('something the policy blocks is reported to the store, as an address without its path', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Top rated')).toBeVisible();
  // Answered here, so the shared demo server's error list stays as other tests expect it.
  let report;
  await page.route('**/api/error-reports', (route) => {
    report = route.request().postDataJSON();
    return route.fulfill({ status: 204 });
  });
  await page.evaluate(() => {
    const img = globalThis.document.createElement('img');
    img.src = 'https://tracker.example.com/pixel.gif?who=me';
    globalThis.document.body.append(img);
  });
  await expect.poll(() => report).toBeTruthy();
  expect(report).toMatchObject({
    kind: 'blocked',
    message: 'Blocked by img-src: https://tracker.example.com',
    path: '/',
  });
});

test('other sites cannot show the store in a frame', async ({ page, baseURL }) => {
  const refused = page.waitForEvent('console', (m) => /frame-ancestors|Refused to (display|frame)/.test(m.text()));
  await page.setContent(`<iframe src="${baseURL}/" title="store"></iframe>`);
  await refused;
  await expect(page.frameLocator('iframe').getByText('Top rated')).toHaveCount(0);
});
