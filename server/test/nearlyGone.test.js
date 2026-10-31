import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { AGAIN_DAYS, NEARLY_GONE_AT, sendNearlyGoneEmails } from '../src/nearlyGone.js';

let t;
let n = 0;
before(async () => {
  t = await startTestServer();
});
after(() => t.stop());

async function register() {
  const call = t.browser();
  call.email = `fan${++n}@example.com`;
  assert.equal(
    (await call('POST', '/auth/register', { name: 'Asha Rao', email: call.email, password: 'password123' })).status,
    201,
  );
  return call;
}
const DAY = 86_400_000;
const BOOK = 'the-quiet-engineer-paperback';
const MUG = 'learning-to-code-with-javascript';
const product = (slug) => t.db.collection('products').findOne({ slug });
const setStock = (slug, stock, extra = {}) =>
  t.db.collection('products').updateOne({ slug }, { $set: { stock, ...extra } });
const save = async (call, slug) =>
  assert.equal((await call('PUT', `/wishlist/${(await product(slug))._id}`)).status, 200);
const emails = (call) => t.mail.sent.filter((m) => m.to.email === call.email && /last few/.test(m.text));

test('one email when a wishlist item is down to its last few, listing everything that is', async () => {
  const asha = await register();
  await save(asha, BOOK);
  await save(asha, MUG);
  await setStock(BOOK, 10);
  await setStock(MUG, 10);
  assert.equal(await sendNearlyGoneEmails(t.ctx), 0);

  await setStock(BOOK, NEARLY_GONE_AT);
  await setStock(MUG, 1);
  assert.equal(await sendNearlyGoneEmails(t.ctx), 1);
  const [mail] = emails(asha);
  assert.equal(mail.subject, '2 things on your wishlist are nearly gone');
  assert.match(mail.text, /only 3 left/);
  assert.match(mail.text, /only 1 left/);
  // Once: the next sweep sends nothing.
  assert.equal(await sendNearlyGoneEmails(t.ctx), 0);
});

test('not for sold-out or hidden products, nor customers who said no; again after a month', async () => {
  const ravi = await register();
  await save(ravi, BOOK);
  await setStock(BOOK, 0);
  assert.equal(await sendNearlyGoneEmails(t.ctx), 0);
  await setStock(BOOK, 2, { active: false });
  assert.equal(await sendNearlyGoneEmails(t.ctx), 0);
  await setStock(BOOK, 2, { active: true });

  const quiet = await register();
  await save(quiet, BOOK);
  assert.equal((await quiet('PUT', '/account/email-preferences', { nearlyGoneEmails: false })).status, 200);
  assert.equal((await quiet('GET', '/auth/me')).body.user.nearlyGoneEmails, false);

  assert.equal(await sendNearlyGoneEmails(t.ctx), 1); // Ravi only (Asha had hers)
  assert.equal(emails(ravi).length, 1);
  assert.equal(emails(ravi)[0].subject, `Nearly gone: ${(await product(BOOK)).title}`);
  assert.equal(emails(quiet).length, 0);

  // A month on, still low: mentioned again.
  const later = new Date(Date.now() + (AGAIN_DAYS + 1) * DAY);
  assert.ok((await sendNearlyGoneEmails(t.ctx, later)) >= 1);
  assert.equal(emails(ravi).length, 2);
});

test('a failed email is tried again on the next sweep', async () => {
  const meera = await register();
  await setStock(MUG, 5);
  await save(meera, MUG);
  await setStock(MUG, 2);
  t.mail.failNext();
  const first = await sendNearlyGoneEmails(t.ctx);
  assert.equal(emails(meera).length, 0);
  assert.ok((await sendNearlyGoneEmails(t.ctx)) >= first);
  assert.equal(emails(meera).length, 1);
});
