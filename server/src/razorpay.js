import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.js';

const hmacHex = (secret, message) => createHmac('sha256', secret).update(message).digest('hex');

function sameHex(expected, actual) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

// The few Razorpay REST calls the store needs, over fetch (no SDK). Amounts are paise, like everywhere else.
// Returns null when online payments aren't configured.
export function razorpayClient(config) {
  if (!config) return null;
  const { keyId, keySecret, webhookSecret, apiUrl } = config;
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(`${apiUrl}/v1${path}`, {
        method,
        headers: { Authorization: auth, ...(body && { 'Content-Type': 'application/json' }) },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      console.error(`Razorpay ${method} ${path} failed:`, err.message);
      throw new HttpError(502, 'The payment service is not reachable. Please try again.', { expose: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data.error?.description ?? `HTTP ${res.status}`;
      console.error(`Razorpay ${method} ${path} returned ${res.status}:`, reason);
      // `razorpayReason` is Razorpay's own explanation, kept for admins (see refundPayment); customers get the message.
      throw Object.assign(
        new HttpError(502, 'The payment service returned an error. Please try again.', { expose: true }),
        {
          razorpayReason: reason,
        },
      );
    }
    return data;
  }

  return {
    keyId,
    webhooksEnabled: Boolean(webhookSecret),
    createOrder: ({ amount, receipt, notes }) =>
      call('POST', '/orders', { amount, currency: 'INR', receipt, notes, payment_capture: true }),
    orderPayments: async (orderId) => (await call('GET', `/orders/${orderId}/payments`)).items ?? [],
    fetchPayment: (paymentId) => call('GET', `/payments/${paymentId}`),
    capture: (paymentId, amount) => call('POST', `/payments/${paymentId}/capture`, { amount, currency: 'INR' }),
    refund: (paymentId, { amount, notes }) =>
      call('POST', `/payments/${paymentId}/refund`, { amount, speed: 'normal', notes }),
    // Checkout's signature: HMAC-SHA256 of "<order id>|<payment id>" with the key secret.
    verifyPayment: ({ orderId, paymentId, signature }) =>
      sameHex(hmacHex(keySecret, `${orderId}|${paymentId}`), signature),
    // Webhook signature: HMAC-SHA256 of the raw request body with the webhook secret.
    verifyWebhook: (rawBody, signature) =>
      Boolean(webhookSecret && rawBody) && sameHex(hmacHex(webhookSecret, rawBody), signature),
  };
}
