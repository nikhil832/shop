import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { DAILY_LIMIT, sendNewsletters } from '../src/newsletters.js';

// Store news emails (stage 140).
let t;
let admin;
const customers = {};
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  for (const name of ['Asha', 'Ravi', 'Meera']) {
    customers[name] = t.browser();
    await customers[name]('POST', '/auth/register', {
      name: `${name} Rao`,
      email: `${name.toLowerCase()}@example.com`,
      password: 'password123',
    });
  }
});
after(() => t.stop());
beforeEach(() => t.db.collection('rateLimits').deleteMany({}));

const user = (name) => t.db.collection('users').findOne({ email: `${name.toLowerCase()}@example.com` });
const LETTER = {
  subject: 'New in: monsoon picks',
  body: 'Hello from Bazaar!\n\nOur monsoon range is in.\nUmbrellas too.',
  link: '/search?deals=1',
  linkText: 'See the deals',
};
const draft = async (body = LETTER) => {
  const res = await admin('POST', '/admin/newsletters', body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};

test('off unless the customer asks; opting in gives an unsubscribe token once', async () => {
  const me = (await customers.Asha('GET', '/auth/me')).body.user;
  assert.equal(me.newsEmails, false);
  const res = await customers.Asha('PUT', '/account/email-preferences', { newsEmails: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.newsEmails, true);
  const token = (await user('Asha')).newsToken;
  assert.match(token, /^[\w-]{24}$/);
  await customers.Asha('PUT', '/account/email-preferences', { newsEmails: false });
  await customers.Asha('PUT', '/account/email-preferences', { newsEmails: true });
  assert.equal((await user('Asha')).newsToken, token);
  await customers.Ravi('PUT', '/account/email-preferences', { newsEmails: true });
  // The data download says so.
  const data = await customers.Asha('GET', '/account/data');
  assert.equal(data.body.account.emails.storeNews, true);
});

test('admins write, test and send; the sweep sends to subscribers with an unsubscribe link and header', async () => {
  assert.equal((await customers.Asha('GET', '/admin/newsletters')).status, 403);
  for (const bad of [
    { ...LETTER, subject: 'x' },
    { ...LETTER, body: '' },
    { ...LETTER, link: 'https://example.com' },
    { ...LETTER, link: '//evil.example' },
  ]) {
    assert.equal((await admin('POST', '/admin/newsletters', bad)).status, 400, JSON.stringify(bad));
  }
  const letter = await draft();
  const edited = await admin('PUT', `/admin/newsletters/${letter.id}`, { ...LETTER, subject: 'New in: rain gear' });
  assert.equal(edited.body.subject, 'New in: rain gear');

  t.mail.sent.length = 0;
  const test = await admin('POST', `/admin/newsletters/${letter.id}/test`);
  assert.equal(test.status, 200, JSON.stringify(test.body));
  assert.equal(t.mail.sent.length, 1);
  assert.equal(t.mail.sent[0].to.email, 'admin@example.com');
  assert.equal(t.mail.sent[0].subject, '[Test] New in: rain gear');

  const list = (await admin('GET', '/admin/newsletters')).body;
  assert.equal(list.subscribers, 2);
  assert.equal(list.dailyLimit, DAILY_LIMIT);

  const sent = await admin('POST', `/admin/newsletters/${letter.id}/send`);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.status, 'sending');
  assert.equal(sent.body.recipients, 2);
  assert.equal((await admin('POST', `/admin/newsletters/${letter.id}/send`)).status, 409);
  assert.equal((await admin('PUT', `/admin/newsletters/${letter.id}`, LETTER)).status, 409);

  t.mail.sent.length = 0;
  assert.equal(await sendNewsletters(t.ctx), 2);
  assert.deepEqual(t.mail.sent.map((m) => m.to.email).sort(), ['asha@example.com', 'ravi@example.com']);
  const asha = await user('Asha');
  const mail = t.mail.sent.find((m) => m.to.email === 'asha@example.com');
  assert.equal(mail.subject, 'New in: rain gear');
  assert.match(mail.text, /Hi Asha,\n\nHello from Bazaar!\n\nOur monsoon range is in.\nUmbrellas too./);
  assert.match(mail.text, /See the deals: https:\/\/bazaar\.test\/search\?deals=1/);
  assert.ok(mail.text.includes(`https://bazaar.test/unsubscribe#token=${asha.newsToken}`));
  assert.match(mail.html, /Our monsoon range is in.<br>Umbrellas too./);
  assert.deepEqual(mail.headers, {
    'List-Unsubscribe': `<https://bazaar.test/api/news/unsubscribe?token=${asha.newsToken}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
  const done = (await admin('GET', '/admin/newsletters')).body.items.find((l) => l.id === letter.id);
  assert.equal(done.status, 'sent');
  assert.equal(done.sent, 2);
  assert.equal(await sendNewsletters(t.ctx), 0); // nothing twice
  const log = await t.db.collection('activity').findOne({ action: 'Sent store news' });
  assert.equal(log.area, 'news');
});

test('unsubscribing: by the link (a POST, never a GET), and queued emails are skipped', async () => {
  const asha = await user('Asha');
  assert.equal((await t.call('POST', '/news/unsubscribe?token=nope')).status, 404);
  assert.equal((await t.call('POST', '/news/unsubscribe?token=abcdefghijklmnopqrstuvwx')).status, 404);
  assert.equal((await t.call('GET', `/news/unsubscribe?token=${asha.newsToken}`)).status, 404);
  assert.equal((await user('Asha')).newsEmails, true);

  const letter = await draft();
  await admin('POST', `/admin/newsletters/${letter.id}/send`);
  const res = await t.call('POST', `/news/unsubscribe?token=${asha.newsToken}`);
  assert.equal(res.status, 200);
  assert.equal((await user('Asha')).newsEmails, false);
  t.mail.sent.length = 0;
  assert.equal(await sendNewsletters(t.ctx), 1);
  assert.deepEqual(
    t.mail.sent.map((m) => m.to.email),
    ['ravi@example.com'],
  );
});

test('a failed send is counted; the day limit holds the rest until tomorrow; nobody subscribed → 409', async () => {
  await customers.Meera('PUT', '/account/email-preferences', { newsEmails: true });
  const letter = await draft();
  await admin('POST', `/admin/newsletters/${letter.id}/send`); // Ravi and Meera
  // The day's limit almost used up: one left.
  const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  await t.db
    .collection('settings')
    .updateOne({ _id: 'newsEmailsDaily' }, { $set: { day, used: DAILY_LIMIT - 1 } }, { upsert: true });
  t.mail.failNext();
  assert.equal(await sendNewsletters(t.ctx), 0); // the one allowed failed
  assert.equal(await sendNewsletters(t.ctx), 0); // the limit is reached
  const after = (await admin('GET', '/admin/newsletters')).body;
  const mine = after.items.find((l) => l.id === letter.id);
  assert.equal(mine.failed, 1);
  assert.equal(mine.status, 'sending');
  assert.equal(after.sentToday, DAILY_LIMIT);
  // Tomorrow it carries on.
  assert.equal(await sendNewsletters(t.ctx, new Date(Date.now() + 86_400_000)), 1);
  assert.equal((await admin('GET', '/admin/newsletters')).body.items.find((l) => l.id === letter.id).status, 'sent');

  await t.db.collection('users').updateMany({}, { $set: { newsEmails: false } });
  const nobody = await admin('POST', `/admin/newsletters/${(await draft()).id}/send`);
  assert.equal(nobody.status, 409);
  // Drafts can be deleted; sent ones can't.
  const spare = await draft();
  assert.equal((await admin('DELETE', `/admin/newsletters/${spare.id}`)).status, 204);
  assert.equal((await admin('DELETE', `/admin/newsletters/${letter.id}`)).status, 409);
});
