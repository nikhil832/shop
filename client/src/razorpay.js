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

// Opens the window for `checkout` (from POST /orders or /orders/:id/pay). Resolves with Checkout's response after a
// successful payment, or null if the customer closed the window.
function openCheckout(checkout, order) {
  return new Promise((resolve) => {
    const secondsLeft = Math.floor((new Date(checkout.expiresAt) - Date.now()) / 1000);
    const rzp = new window.Razorpay({
      key: checkout.keyId,
      order_id: checkout.orderId,
      amount: checkout.amount,
      currency: checkout.currency,
      name: 'Bazaar',
      description: `Order #${orderNumber(order)}`,
      prefill: checkout.prefill,
      // Close the window a minute before the order's payment window ends.
      timeout: Math.max(60, secondsLeft - 60),
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
  const response = await openCheckout(checkout, order);
  if (!response) return null;
  return request(`/orders/${order.id}/payment`, { method: 'POST', body: response });
}
