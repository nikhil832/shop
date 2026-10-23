import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mailClient } from '../src/mail.js';
import { expireUnpaidOrders } from '../src/routes/orders.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
before(async () => {
  t = await startTestServer({ razorpay: true });
  admin = await register('admin@example.com');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

const PHONE = 'orbit-a14-4gb-ram-64gb'; // ₹8,999, stock 40
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 <MG> Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};

let n = 0;
async function register(email = `buyer${++n}@example.com`) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name: 'Asha Rao', email, password: 'password123' });
  assert.equal(res.status, 201);
  call.email = email;
  return call;
}

async function placeOrder(call, paymentMethod = 'cod', qty = 1) {
  const p = await t.db.collection('products').findOne({ slug: PHONE });
  return call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty }],
    address,
    expectedTotal: p.price * qty,
    paymentMethod,
  });
}

const mailsTo = (call) => t.mail.sent.filter((m) => m.to.email === call.email);
const alertsTo = (email) => t.mail.sent.filter((m) => m.to.email === email && m.subject.startsWith('New order'));

test('a COD order gets a confirmation with items, total and address, escaped in the HTML', async () => {
  const call = await register();
  const order = (await placeOrder(call, 'cod', 2)).body;

  const [mail, ...more] = mailsTo(call);
  assert.equal(more.length, 0);
  assert.deepEqual(mail.to, { email: call.email, name: 'Asha Rao' });
  assert.equal(mail.subject, `Order #${order.number} confirmed`);
  assert.match(mail.text, /^Hi Asha,/);
  assert.match(mail.text, /You'll pay ₹17,998 in cash when it arrives/);
  assert.match(mail.text, /Orbit A14 \(4GB RAM, 64GB\) × 2: ₹17,998/);
  assert.match(mail.text, /Delivery: Free/);
  assert.match(mail.text, /12 <MG> Road/);
  assert.match(mail.text, new RegExp(`https://bazaar.test/orders/${order.id}`));
  assert.match(mail.html, /12 &lt;MG&gt; Road/);
  assert.ok(!mail.html.includes('<MG>'));
});

test('shipping and delivery are emailed, and delivery links each item for a review', async () => {
  const call = await register();
  const order = (await placeOrder(call)).body;
  for (const status of ['shipped', 'delivered']) {
    assert.equal((await admin('POST', `/admin/orders/${order.id}/status`, { status })).status, 200);
  }
  const [, shipped, delivered] = mailsTo(call);
  assert.equal(shipped.subject, `Order #${order.number} has shipped`);
  assert.match(shipped.text, /on its way to Bengaluru/);
  assert.equal(delivered.subject, `Order #${order.number} delivered`);
  assert.match(delivered.text, /review: https:\/\/bazaar\.test\/p\/orbit-a14-4gb-ram-64gb/);
  assert.match(delivered.html, /href="https:\/\/bazaar\.test\/p\/orbit-a14-4gb-ram-64gb"/);

  // A refused step sends nothing.
  assert.equal((await admin('POST', `/admin/orders/${order.id}/status`, { status: 'shipped' })).status, 409);
  assert.equal(mailsTo(call).length, 3);
});

test('an online order is confirmed once it is paid, however many times the payment is reported', async () => {
  const call = await register();
  const order = (await placeOrder(call, 'razorpay')).body;
  assert.equal(mailsTo(call).length, 0); // not confirmed while awaiting payment

  const { payment, response } = t.fake.pay(order.payment.razorpayOrderId);
  assert.equal((await call('POST', `/orders/${order.id}/payment`, response)).status, 200);
  const { body, signature } = t.fake.webhook('payment.captured', payment);
  assert.equal((await t.webhook(body, signature)).status, 200);
  assert.equal((await call('POST', `/orders/${order.id}/payment/check`)).status, 200);

  const mails = mailsTo(call);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, `Order #${order.number} confirmed`);
  assert.match(mails[0].text, /We've received your payment of ₹8,999/);
});

test('cancelling a paid order says the refund has started', async () => {
  const call = await register();
  const order = (await placeOrder(call, 'razorpay')).body;
  await call('POST', `/orders/${order.id}/payment`, t.fake.pay(order.payment.razorpayOrderId).response);
  assert.equal((await call('POST', `/orders/${order.id}/cancel`)).status, 200);

  const cancelled = mailsTo(call).at(-1);
  assert.equal(cancelled.subject, `Order #${order.number} cancelled`);
  assert.match(cancelled.text, /cancelled, as you asked/);
  assert.match(cancelled.text, /started a refund of ₹8,999/);
});

test('an admin cancelling a COD order says so, with nothing about refunds', async () => {
  const call = await register();
  const order = (await placeOrder(call)).body;
  assert.equal((await admin('POST', `/admin/orders/${order.id}/status`, { status: 'cancelled' })).status, 200);
  const cancelled = mailsTo(call).at(-1);
  assert.match(cancelled.text, /we had to cancel your order/);
  assert.ok(!/refund|charged/i.test(cancelled.text));
});

test('an expired unpaid order is cancelled with an email saying nothing was charged', async () => {
  const call = await register();
  const order = (await placeOrder(call, 'razorpay')).body;
  await t.db
    .collection('orders')
    .updateOne({ number: order.number }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await expireUnpaidOrders(t.ctx);

  const [mail, ...more] = mailsTo(call);
  assert.equal(more.length, 0);
  assert.equal(mail.subject, `Order #${order.number} cancelled`);
  assert.match(mail.text, /payment wasn't completed within 30 minutes/);
  assert.match(mail.text, /Nothing was charged/);
});

test('no email for an order Razorpay refused at checkout', async () => {
  const call = await register();
  t.fake.failNext('POST /v1/orders');
  assert.equal((await placeOrder(call, 'razorpay')).status, 502);
  assert.equal(mailsTo(call).length, 0);
});

test('a failed email never fails the order', async () => {
  const call = await register();
  t.mail.failNext();
  const res = await placeOrder(call);
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'placed');
  assert.equal(mailsTo(call).length, 0);
});

test("the Brevo client sends the message in Brevo's format, and reports its errors", async () => {
  const requests = [];
  let status = 201;
  const brevo = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, key: req.headers['api-key'], body: JSON.parse(body) });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status === 201 ? { messageId: '<1@brevo>' } : { message: 'Key not found' }));
    });
  }).listen(0);
  await new Promise((resolve) => brevo.once('listening', resolve));
  try {
    const mail = mailClient({
      apiKey: 'xkeysib-test',
      from: 'shop@example.com',
      fromName: 'Bazaar',
      apiUrl: `http://localhost:${brevo.address().port}`,
    });
    const message = { to: { email: 'a@example.com', name: 'Asha' }, subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };
    await mail.send(message);
    assert.deepEqual(requests[0], {
      method: 'POST',
      url: '/v3/smtp/email',
      key: 'xkeysib-test',
      body: {
        sender: { email: 'shop@example.com', name: 'Bazaar' },
        to: [{ email: 'a@example.com', name: 'Asha' }],
        subject: 'Hi',
        htmlContent: '<p>Hi</p>',
        textContent: 'Hi',
      },
    });

    status = 401;
    await assert.rejects(mail.send(message), /Brevo returned 401: Key not found/);
  } finally {
    brevo.close();
  }
});

test('admins are emailed each new COD order, with the customer, items and a link to the admin page', async () => {
  const before = alertsTo('admin@example.com').length;
  const call = await register();
  const order = (await placeOrder(call, 'cod', 2)).body;

  const alerts = alertsTo('admin@example.com');
  assert.equal(alerts.length, before + 1);
  const alert = alerts.at(-1);
  assert.deepEqual(alert.to, { email: 'admin@example.com', name: 'Asha Rao' });
  assert.equal(alert.subject, `New order #${order.number}: ₹17,998 (Cash on Delivery)`);
  assert.match(alert.text, new RegExp(`^Asha Rao \\(${call.email}\\) placed an order\\. Cash on Delivery\\.`));
  assert.match(alert.text, /Deliver to Bengaluru, Karnataka 560001/);
  assert.match(alert.text, /Orbit A14 \(4GB RAM, 64GB\) × 2: ₹17,998/);
  assert.match(alert.text, /Total: ₹17,998/);
  assert.match(alert.text, new RegExp(`https://bazaar.test/admin/orders/${order.id}`));
  assert.match(alert.html, /Open the order/);
  // The customer's own confirmation is separate.
  assert.equal(mailsTo(call).length, 1);
});

test('admins hear about an online order once, when it is paid, not while it awaits payment', async () => {
  const call = await register();
  const order = (await placeOrder(call, 'razorpay')).body;
  const forOrder = () => alertsTo('admin@example.com').filter((m) => m.subject.includes(`#${order.number}:`));
  assert.equal(forOrder().length, 0);

  const { payment, response } = t.fake.pay(order.payment.razorpayOrderId);
  assert.equal((await call('POST', `/orders/${order.id}/payment`, response)).status, 200);
  const { body, signature } = t.fake.webhook('payment.captured', payment);
  assert.equal((await t.webhook(body, signature)).status, 200);
  assert.equal((await call('POST', `/orders/${order.id}/payment/check`)).status, 200);

  assert.equal(forOrder().length, 1);
  assert.equal(forOrder()[0].subject, `New order #${order.number}: ₹8,999 (Paid online)`);
});

test('ADMIN_EMAIL sends the alerts there instead of to the admin accounts', async () => {
  t.ctx.config.mail.adminEmails = ['owner@example.com', 'helper@example.com'];
  try {
    const before = alertsTo('admin@example.com').length;
    const order = (await placeOrder(await register())).body;
    for (const email of ['owner@example.com', 'helper@example.com']) {
      const alert = alertsTo(email).at(-1);
      assert.deepEqual(alert.to, { email });
      assert.ok(alert.subject.startsWith(`New order #${order.number}:`));
    }
    assert.equal(alertsTo('admin@example.com').length, before);
  } finally {
    t.ctx.config.mail.adminEmails = [];
  }
});

test('a failed alert never fails the order, and the other admins still get theirs', async () => {
  t.ctx.config.mail.adminEmails = ['owner@example.com', 'helper@example.com'];
  try {
    const call = await register();
    const original = t.mail.send;
    // Only the alert to owner@ fails.
    t.mail.send = async function (message) {
      if (message.to.email === 'owner@example.com') throw new Error('mail service down');
      return original.call(this, message);
    };
    const ownerBefore = alertsTo('owner@example.com').length;
    let res;
    try {
      res = await placeOrder(call);
    } finally {
      t.mail.send = original;
    }
    assert.equal(res.status, 201);
    assert.equal(mailsTo(call).length, 1);
    assert.equal(alertsTo('owner@example.com').length, ownerBefore);
    assert.ok(alertsTo('helper@example.com').at(-1).subject.startsWith(`New order #${res.body.number}:`));
  } finally {
    t.ctx.config.mail.adminEmails = [];
  }
});
