import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Loads the config in a child process (it exits on bad settings) with the given Razorpay variables.
function loadWith(env) {
  const script =
    "const { loadConfig } = await import('./src/config.js'); const c = loadConfig(); console.log(JSON.stringify(c.razorpay && { ...c.razorpay, keySecret: '***' }));";
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    env: {
      PATH: process.env.PATH,
      MONGODB_URI: 'mongodb://unused',
      RAZORPAY_KEY_ID: '',
      RAZORPAY_KEY_SECRET: '',
      ...env,
    },
    encoding: 'utf8',
  });
}

test('refuses live Razorpay keys, and a key without its secret', () => {
  const live = loadWith({ RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_KEY_SECRET: 'secret-value' });
  assert.equal(live.status, 1);
  assert.match(live.stderr, /must be a test-mode key/);
  assert.ok(!live.stderr.includes('secret-value') && !live.stderr.includes('rzp_live_abc'));

  const half = loadWith({ RAZORPAY_KEY_ID: 'rzp_test_abc' });
  assert.equal(half.status, 1);
  assert.match(half.stderr, /Set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET/);
});

test('accepts test keys, and runs without any', () => {
  const ok = loadWith({ RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 's' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).keyId, 'rzp_test_abc');
  const none = loadWith({});
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout.trim(), 'null');
});

test('emails need a sender address along with the Brevo key, which is never printed', () => {
  const script =
    "const { loadConfig } = await import('./src/config.js'); const { mail } = loadConfig(); console.log(JSON.stringify({ ...mail, apiKey: mail.apiKey && '***' }));";
  const run = (env) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url),
      env: { PATH: process.env.PATH, MONGODB_URI: 'mongodb://unused', BREVO_API_KEY: '', MAIL_FROM: '', ...env },
      encoding: 'utf8',
    });

  const noSender = run({ BREVO_API_KEY: 'xkeysib-secret-value' });
  assert.equal(noSender.status, 1);
  assert.match(noSender.stderr, /Set MAIL_FROM/);
  assert.ok(!noSender.stderr.includes('xkeysib-secret-value'));

  const ok = run({ BREVO_API_KEY: 'k', MAIL_FROM: 'shop@example.com', PUBLIC_URL: 'https://bazaar.example/' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), {
    apiKey: '***',
    from: 'shop@example.com',
    fromName: 'Bazaar',
    adminEmails: [],
    publicUrl: 'https://bazaar.example',
    apiUrl: 'https://api.brevo.com',
  });

  const off = run({});
  assert.equal(off.status, 0, off.stderr);
  assert.equal(JSON.parse(off.stdout).apiKey, null);

  // The header naming the visitor's IP, as the host's edge sets it: configured, Render's by default there, or none.
  const ipHeader = (env) =>
    JSON.parse(
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "const { loadConfig } = await import('./src/config.js'); console.log(JSON.stringify(loadConfig().clientIpHeader));",
        ],
        {
          cwd: new URL('..', import.meta.url),
          env: { PATH: process.env.PATH, MONGODB_URI: 'mongodb://unused', ...env },
          encoding: 'utf8',
        },
      ).stdout,
    );
  assert.equal(ipHeader({ CLIENT_IP_HEADER: ' X-Real-IP ' }), 'x-real-ip');
  assert.equal(ipHeader({ RENDER: 'true' }), 'cf-connecting-ip');
  assert.equal(ipHeader({}), null);

  // New-order alerts: one address or a comma-separated list.
  const admins = run({ ADMIN_EMAIL: ' owner@example.com, , helper@example.com ' });
  assert.equal(admins.status, 0, admins.stderr);
  assert.deepEqual(JSON.parse(admins.stdout).adminEmails, ['owner@example.com', 'helper@example.com']);
});

test("Google's verification code is kept only when it looks like one", () => {
  const code = (value) =>
    JSON.parse(
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "const { loadConfig } = await import('./src/config.js'); console.log(JSON.stringify(loadConfig().googleSiteVerification));",
        ],
        {
          cwd: new URL('..', import.meta.url),
          env: { PATH: process.env.PATH, MONGODB_URI: 'mongodb://unused', GOOGLE_SITE_VERIFICATION: value },
          encoding: 'utf8',
        },
      ).stdout,
    );
  assert.equal(code(' aB3_-xYz0123456789 '), 'aB3_-xYz0123456789');
  assert.equal(code('"><script>alert(1)</script>'), null);
  assert.equal(code(''), null);
});
