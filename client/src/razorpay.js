import { request } from './api.js';
import { orderNumber } from './format.js';

// Razorpay's checkout window. Their script is loaded only when someone actually pays online.
const SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';
let scriptLoad = null;

function loadScript() {
  scriptLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.onload = resolve;
    script.onerror = () => {
      scriptLoad = null; // allow another try
      reject(new Error('Could not open the payment window. Check your connection and try again.'));
    };
    document.head.append(script);
  });
  return scriptLoad;
}

// Opens the window for `checkout` (from POST /orders, /orders/:id/pay or /gift-cards). Resolves with Checkout's response
// after a successful payment, or null if the customer closed the window.
function openCheckout(checkout, description) {
  return new Promise((resolve) => {
    const secondsLeft = checkout.expiresAt ? Math.floor((new Date(checkout.expiresAt) - Date.now()) / 1000) : null;
    const rzp = new window.Razorpay({
      key: checkout.keyId,
      order_id: checkout.orderId,
      amount: checkout.amount,
      currency: checkout.currency,
      name: 'Bazaar',
      description,
      prefill: checkout.prefill,
      // Close the window a minute before an order's payment window ends (gift cards have none).
      ...(secondsLeft !== null && { timeout: Math.max(60, secondsLeft - 60) }),
      theme: { color: '#2563eb' },
      handler: resolve,
      modal: { ondismiss: () => resolve(null) },
    });
    rzp.open();
  });
}

// Pays for an order: opens Razorpay, then has the server verify the payment. Returns the updated order, or null if
// the customer closed the window without paying.
export async function payOrder(order, checkout) {
  await loadScript();
  const response = await openCheckout(checkout, `Order #${orderNumber(order)}`);
  if (!response) return null;
  return request(`/orders/${order.id}/payment`, { method: 'POST', body: response });
}

// Pays for a gift card just started (POST /gift-cards) and has the server verify it. Returns the card, or null if the
// window was closed (the unpaid card is simply never sent).
export async function payGiftCard(card, checkout) {
  await loadScript();
  const response = await openCheckout(checkout, `Gift card for ${card.recipient.name}`);
  if (!response) return null;
  return request(`/gift-cards/${card.id}/payment`, { method: 'POST', body: response });
}
