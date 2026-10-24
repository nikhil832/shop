import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { sendLowStockEmail } from '../src/lowStockEmail.js';
import { lowStockEmail } from '../src/emails.js';

let t;
before(async () => {
  t = await startTestServer();
  t.ctx.config.mail.adminEmails = ['owner@example.com', 'helper@example.com'];
});
after(() => t.stop());

// A moment in India time (UTC+5:30) on 2026-10-<day>.
const ist = (day, hhmm) => new Date(`2026-10-${day}T${hhmm}:00+05:30`);
const lowMails = () => t.mail.sent.filter((m) => m.subject.startsWith('Low stock'));
const low = { active: true, $or: [{ stock: { $lte: 5 } }, { 'variants.stock': { $lte: 5 } }] };

test('once a day from 9:00 India time, each admin gets the list of products running out', async () => {
  assert.equal(await sendLowStockEmail(t.ctx, ist('20', '08:59')), 'early');
  assert.equal(lowMails().length, 0);

  assert.equal(await sendLowStockEmail(t.ctx, ist('20', '09:00')), 'sent');
  const mails = lowMails();
  assert.deepEqual(mails.map((m) => m.to.email).sort(), ['helper@example.com', 'owner@example.com']);
  const total = await t.db.collection('products').countDocuments(low);
  assert.match(mails[0].subject, new RegExp(`^Low stock: ${total} products to restock \\(\\d+ sold out\\)$`));
  // Sold out first; a product with sizes names the ones that are low.
  assert.match(mails[0].text, /^These products in the store have 5 or fewer left\.\n\n[^\n]+: sold out/);
  assert.match(mails[0].text, /Urbane Men Slim Fit Jeans: \d+ left \([^)]*Blue \/ 30: sold out/);
  assert.ok(mails[0].text.includes('https://bazaar.test/admin/products?status=low'));
  assert.ok(mails[0].html.includes('Open low stock'));

  // Later the same day, and after a restart: nothing more.
  assert.equal(await sendLowStockEmail(t.ctx, ist('20', '15:00')), 'done');
  assert.equal(await sendLowStockEmail(t.ctx, ist('20', '23:59')), 'done');
  assert.equal(lowMails().length, 2);

  // The next morning, again; past midnight India time is still before 9 there.
  assert.equal(await sendLowStockEmail(t.ctx, ist('21', '00:30')), 'early');
  assert.equal(await sendLowStockEmail(t.ctx, ist('21', '11:00')), 'sent');
  assert.equal(lowMails().length, 4);
});

test('two servers checking at the same moment send it once', async () => {
  const before = lowMails().length;
  const results = await Promise.all([1, 2, 3].map(() => sendLowStockEmail(t.ctx, ist('22', '09:01'))));
  assert.deepEqual(results.sort(), ['done', 'done', 'sent']);
  assert.equal(lowMails().length, before + 2);
});

test('hidden products are left out, and nothing is sent when nothing is low', async () => {
  const products = t.db.collection('products');
  const sold = await products.findOne({ active: true, stock: 0 });
  await products.updateOne({ _id: sold._id }, { $set: { active: false } });
  await sendLowStockEmail(t.ctx, ist('23', '09:00'));
  assert.ok(!lowMails().at(-1).text.includes(`${sold.title}:`));

  const lowIds = (await products.find(low, { projection: { _id: 1 } }).toArray()).map((p) => p._id);
  await products.updateMany({ _id: { $in: lowIds } }, { $set: { active: false } });
  const before = lowMails().length;
  assert.equal(await sendLowStockEmail(t.ctx, ist('24', '09:00')), 'none');
  assert.equal(lowMails().length, before);
  await products.updateMany({ _id: { $in: [...lowIds, sold._id] } }, { $set: { active: true } });
});

test('a failed send to one admin still reaches the other', async () => {
  t.mail.failNext();
  const before = lowMails().length;
  assert.equal(await sendLowStockEmail(t.ctx, ist('25', '09:00')), 'sent');
  assert.equal(lowMails().length, before + 1);
});

test('switched off, nothing is sent (and the day stays unclaimed); switched back on, it comes that day', async () => {
  const settings = t.db.collection('settings');
  await settings.updateOne({ _id: 'lowStockEmail' }, { $set: { enabled: false } });
  const before = lowMails().length;
  assert.equal(await sendLowStockEmail(t.ctx, ist('26', '09:00')), 'off');
  assert.equal(await sendLowStockEmail(t.ctx, ist('26', '12:00')), 'off');
  assert.equal(lowMails().length, before);

  await settings.updateOne({ _id: 'lowStockEmail' }, { $set: { enabled: true } });
  assert.equal(await sendLowStockEmail(t.ctx, ist('26', '12:01')), 'sent');
  assert.equal(lowMails().length, before + 2);
});

test('the email lists at most a page, says how many more, and escapes titles', () => {
  const products = [
    { title: 'Mug <b>"Best"</b>', stock: 0, variants: [] },
    { title: 'Tee', stock: 3, variants: [{ label: 'M', stock: 0 }] },
  ];
  const mail = lowStockEmail(products, 60, 'https://shop.example');
  assert.equal(mail.subject, 'Low stock: 60 products to restock (1 sold out)');
  assert.ok(mail.text.includes('Tee: 3 left (M: sold out)'));
  assert.ok(mail.text.includes('And 58 more.'));
  assert.ok(!mail.html.includes('<b>"Best"</b>'));
  assert.ok(mail.html.includes('Mug &lt;b&gt;&quot;Best&quot;&lt;/b&gt;'));
  assert.equal(lowStockEmail(products.slice(1), 1).subject, 'Low stock: 1 product to restock');
});
