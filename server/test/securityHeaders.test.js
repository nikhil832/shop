import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_SECURITY_POLICY, HSTS } from '../src/securityHeaders.js';
import { startTestServer } from './helpers.js';

let t;
before(async () => {
  t = await startTestServer();
});
after(() => t.stop());

// The policy as { directive: [values] }.
const directives = (policy) =>
  Object.fromEntries(policy.split('; ').map((part) => [part.split(' ')[0], part.split(' ').slice(1)]));

test('every response carries the security headers, errors and 404s included', async () => {
  for (const [method, path] of [
    ['GET', '/products'],
    ['GET', '/no-such-thing'],
    ['GET', '/admin/orders'],
  ]) {
    const { headers } = await t.call(method, path);
    assert.equal(headers.get('content-security-policy'), CONTENT_SECURITY_POLICY, path);
    assert.equal(headers.get('x-frame-options'), 'DENY');
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.match(headers.get('permissions-policy'), /camera=\(\)/);
    assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
  }
});

test('the policy allows only the store itself and Razorpay, and no framing', () => {
  const csp = directives(CONTENT_SECURITY_POLICY);
  assert.deepEqual(csp['default-src'], ["'self'"]);
  assert.deepEqual(csp['script-src'], ["'self'", 'https://checkout.razorpay.com']);
  assert.ok(!csp['script-src'].includes("'unsafe-inline'") && !csp['script-src'].includes("'unsafe-eval'"));
  assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
  assert.deepEqual(csp['object-src'], ["'none'"]);
  assert.deepEqual(csp['frame-src'], ['https://*.razorpay.com']);
  // The sample catalog's drawings are data: addresses.
  assert.ok(csp['img-src'].includes('data:'));
});

test('HTTPS-only (HSTS) is sent over HTTPS, never over plain HTTP', async () => {
  const plain = await fetch(`${t.base}/products`);
  assert.equal(plain.headers.get('strict-transport-security'), null);
  // Behind Render's proxy (trust proxy 1) the request arrives with X-Forwarded-Proto: https.
  const secure = await fetch(`${t.base}/products`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(secure.headers.get('strict-transport-security'), HSTS);
});

test('what the policy blocked can be reported, and is listed with the other errors', async () => {
  const sent = await t.call('POST', '/error-reports', {
    kind: 'blocked',
    message: 'Blocked by frame-src: https://pay.example.com',
    path: '/checkout',
  });
  assert.equal(sent.status, 204);
  const doc = await t.db.collection('errorReports').findOne({ kind: 'blocked' });
  assert.equal(doc.message, 'Blocked by frame-src: https://pay.example.com');
  assert.deepEqual(doc.paths, ['/checkout']);
  assert.equal((await t.call('POST', '/error-reports', { kind: 'other', message: 'x', path: '/' })).status, 400);
});
