// A stand-in for the Razorpay REST API, so tests (and the e2e demo server) never call the real service.
// Implements just the calls the store makes, plus test-only endpoints to "pay" an order and to make the next call fail.
// Run directly for the e2e tests: FAKE_RAZORPAY_PORT=4101 node server/test/fake-razorpay.js
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const FAKE_KEYS = {
  keyId: 'rzp_test_fakekey000000',
  keySecret: 'fake_secret_for_tests',
  webhookSecret: 'fake_webhook_secret',
};

const newId = (prefix) => `${prefix}_${randomBytes(7).toString('hex')}`;
const sign = (secret, message) => createHmac('sha256', secret).update(message).digest('hex');

export async function startFakeRazorpay({ keyId, keySecret, webhookSecret } = FAKE_KEYS, port = 0) {
  const state = { orders: new Map(), payments: new Map(), refunds: [], calls: [], failNext: [] };
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  // Test-only: a captured (or authorized/failed) payment for an order, with the signature Checkout would return.
  function pay(orderId, status = 'captured') {
    const order = state.orders.get(orderId);
    if (!order) throw new Error(`No fake order ${orderId}`);
    const payment = {
      id: newId('pay'),
      entity: 'payment',
      amount: order.amount,
      currency: 'INR',
      status,
      order_id: orderId,
      method: 'upi',
      captured: status === 'captured',
      amount_refunded: 0,
      refund_status: null,
    };
    state.payments.set(payment.id, payment);
    if (status === 'captured') order.status = 'paid';
    return {
      payment,
      response: {
        razorpay_order_id: orderId,
        razorpay_payment_id: payment.id,
        razorpay_signature: sign(keySecret, `${orderId}|${payment.id}`),
      },
    };
  }

  // A signed webhook delivery for a payment, as Razorpay would send it.
  function webhook(event, payment) {
    const body = JSON.stringify({ entity: 'event', event, payload: { payment: { entity: payment } } });
    return { body, signature: sign(webhookSecret, body) };
  }

  function route(method, path, body) {
    let m;
    if (method === 'POST' && path === '/v1/orders') {
      const order = { id: newId('order'), entity: 'order', status: 'created', ...body, amount_paid: 0 };
      state.orders.set(order.id, order);
      return [200, order];
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/orders\/([\w]+)\/payments$/))) {
      const items = [...state.payments.values()].filter((p) => p.order_id === m[1]);
      return [200, { entity: 'collection', count: items.length, items }];
    }
    if ((m = path.match(/^\/v1\/payments\/([\w]+)(\/capture|\/refund)?$/))) {
      const payment = state.payments.get(m[1]);
      if (!payment)
        return [400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } }];
      if (method === 'GET' && !m[2]) return [200, payment];
      if (method === 'POST' && m[2] === '/capture') {
        if (payment.status !== 'authorized' || body.amount !== payment.amount) {
          return [400, { error: { description: 'Payment cannot be captured' } }];
        }
        Object.assign(payment, { status: 'captured', captured: true });
        state.orders.get(payment.order_id).status = 'paid';
        return [200, payment];
      }
      if (method === 'POST' && m[2] === '/refund') {
        if (payment.status !== 'captured' || payment.amount_refunded + body.amount > payment.amount) {
          return [400, { error: { description: 'The refund amount is invalid' } }];
        }
        const refund = {
          id: newId('rfnd'),
          entity: 'refund',
          payment_id: payment.id,
          amount: body.amount,
          status: 'processed',
        };
        payment.amount_refunded += body.amount;
        payment.refund_status = payment.amount_refunded === payment.amount ? 'full' : 'partial';
        state.refunds.push(refund);
        return [200, refund];
      }
    }
    return [404, { error: { description: 'Not found' } }];
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : {};
    const send = (status, data) => {
      // The e2e checkout stub calls /test/pay from the browser.
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'OPTIONS') return send(204, {});
    const path = req.url.split('?')[0];

    if (path === '/test/pay' && req.method === 'POST') {
      try {
        return send(200, pay(body.order_id, body.status).response);
      } catch (err) {
        return send(400, { error: { description: err.message } });
      }
    }
    if (req.headers.authorization !== auth) return send(401, { error: { description: 'Authentication failed' } });
    state.calls.push(`${req.method} ${path}`);
    const fail = state.failNext.findIndex((prefix) => `${req.method} ${path}`.startsWith(prefix));
    if (fail !== -1) {
      state.failNext.splice(fail, 1);
      return send(500, { error: { description: 'Simulated failure' } });
    }
    send(...route(req.method, path, body));
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return {
    url: `http://localhost:${server.address().port}`,
    state,
    pay,
    webhook,
    // The next call starting with e.g. 'POST /v1/payments' answers 500.
    failNext: (prefix) => state.failNext.push(prefix),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeRazorpay(FAKE_KEYS, Number(process.env.FAKE_RAZORPAY_PORT) || 4101);
  console.log(`Fake Razorpay listening on ${fake.url}`);
}
