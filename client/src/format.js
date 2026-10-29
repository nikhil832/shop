const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

// Prices are integers in paise.
export const formatPrice = (paise) => inr.format(paise / 100);
// With paise ("₹686.36"), for tax invoices: their lines must add up to the paisa.
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
export const formatAmount = (paise) => inr2.format(paise / 100);

export const discountPercent = (price, mrp) => (mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0);

const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
export const formatDate = (iso) => dateFormat.format(new Date(iso));

// The order's sequential number; orders from before numbering show the end of their id instead.
export const orderNumber = (order) => String(order.number ?? order.id.slice(-8).toUpperCase());

// Orders that have an invoice: placed and not cancelled. Unpaid online orders aren't sales yet.
export const hasInvoice = (order) => ['placed', 'shipped', 'delivered'].includes(order.status);

export const ORDER_STATUS = {
  awaiting_payment: 'Awaiting payment',
  placed: 'Placed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

// How an order is (being) paid, in words. `admin` shows refund problems as they are. Razorpay takes a few working days
// to return the money, so a refund it accepted is "started", not done.
export function paymentLabel(payment, { admin = false } = {}) {
  if (payment.method === 'cod') return 'Cash on Delivery';
  if (payment.method === 'credit') return 'Store credit';
  return {
    pending: 'Online · not paid',
    paid: 'Paid online',
    refunding: 'Paid online · refund in progress',
    refunded: 'Paid online · refund started',
    refund_failed: admin ? 'Paid online · refund failed' : 'Paid online · refund in progress',
  }[payment.status];
}

export const formatTime = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

// Prices are typed in rupees (decimals allowed) and stored in paise.
export const toPaise = (rupees) => Math.round(Number(rupees) * 100);
export const toRupees = (paise) => String(paise / 100);

// A return's status in words. Customers aren't told about a failed refund (it is being retried), and Razorpay takes a
// few working days to return money, so an online refund is "started".
export function returnStatusLabel(ret, { admin = false } = {}) {
  const online = ret.refundMethod === 'razorpay';
  return {
    requested: 'Waiting for review',
    approved: online
      ? 'Approved · refund in progress'
      : admin
        ? 'Approved · refund to pay'
        : 'Approved · refund on its way',
    refunding: 'Approved · refund in progress',
    refunded: online ? 'Refund started' : 'Refunded',
    refund_failed: admin ? 'Refund failed' : 'Approved · refund in progress',
    declined: 'Declined',
  }[ret.status];
}

// An exchange's status in words (stage 89).
export function exchangeStatusLabel(ex, { admin = false } = {}) {
  return {
    requested: 'Waiting for review',
    approved: admin ? 'Approved · to ship' : 'Approved · new item on its way soon',
    shipped: 'New item shipped',
    delivered: 'New item delivered',
    declined: 'Declined',
    cancelled: 'Called off',
  }[ex.status];
}

// A saved address on one line: "12 MG Road, Near the metro, Bengaluru, Karnataka 560001".
export const addressLine = (a) => [a.line1, a.line2, a.city, `${a.state} ${a.pincode}`].filter(Boolean).join(', ');
// The address fields alone, as orders take them (without the address book's id and label).
export const addressFields = ({ name, phone, line1, line2, city, state, pincode }) => ({
  name,
  phone,
  line1,
  line2,
  city,
  state,
  pincode,
});
// How many addresses the book keeps (MAX_ADDRESSES on the server).
export const MAX_ADDRESSES = 10;

// What a help request is about (TOPICS in server/src/routes/help.js), and its state, in words.
export const HELP_TOPICS = {
  order: 'An order',
  product: 'A product',
  payment: 'Payment or refund',
  account: 'My account',
  other: 'Something else',
};
export const HELP_STATUS = { waiting: 'Waiting for us', answered: 'Answered', closed: 'Closed' };

// "Sale ends in 2 days" / "in 5 hours" / "soon", for a sale's `endsAt` (stage 67).
export function saleEndsIn(endsAt, now = Date.now()) {
  const ms = new Date(endsAt) - now;
  const days = Math.floor(ms / 86_400_000);
  if (days >= 2) return `Sale ends in ${days} days`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 2) return `Sale ends in ${hours} hours`;
  return 'Sale ends soon';
}

// The small version of an uploaded product photo (stage 68), for cards, carts and lists; drawings stay as they are.
// The server sends the photo itself when it has no small version.
export const smallImage = (src) => (src?.startsWith('/api/images/') ? `${src}?size=small` : src);

// What to call the part of an order store credit didn't pay (OrderSummary's last line).
export const dueLabel = (order) =>
  order.payment.method === 'razorpay'
    ? order.payment.status === 'pending'
      ? 'To pay online'
      : 'Paid online'
    : order.deliveredAt
      ? 'Paid on delivery'
      : 'To pay on delivery';

// How a return's refund is paid (stage 72): "₹349 as store credit", or "₹49 online + ₹300 as store credit".
export function refundText(r) {
  const credit = r.refundCredit ?? 0;
  const money = r.refund - credit;
  const how = r.refundMethod === 'razorpay' ? 'online' : 'by the store';
  if (!money) return `${formatPrice(credit)} as store credit`;
  return credit ? `${formatPrice(money)} ${how} + ${formatPrice(credit)} as store credit` : formatPrice(money);
}

// Why a parcel came back undelivered (stage 79; the same as server/src/cod.js).
export const RTO_REASONS = {
  refused: 'Refused by the customer',
  unreachable: 'Customer couldn’t be reached',
  address: 'Wrong or incomplete address',
  other: 'Something else',
};

// When an order should arrive (stage 86): "by Thu, 31 Oct" or "between Thu, 31 Oct and Mon, 4 Nov". The dates are
// India-time days ('YYYY-MM-DD'), the same wording as the confirmation email.
const arrivalDay = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
export const arrival = ({ from, to }) =>
  from === to ? `by ${arrivalDay(to)}` : `between ${arrivalDay(from)} and ${arrivalDay(to)}`;
