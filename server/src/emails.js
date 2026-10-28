import { variantTitle } from './variants.js';

// Customer emails: order confirmed (placed), shipped, delivered and cancelled, sent after the change is saved (a failure
// is logged and never undoes or fails the change itself), the password reset link and back-in-stock alerts. And one for
// the store's admins: a new order to pack.

const DEFAULT_PUBLIC_URL = 'http://localhost:5173';

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
// What an order costs in money once store credit paid its part (credit.js has the same; this module imports nothing
// from it, to keep imports one-way).
const due = (order) => order.total - (order.creditUsed ?? 0);
const orderNumber = (order) => order.number ?? order._id.toString().slice(-8).toUpperCase();
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const button = (label, url) =>
  `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:#2563eb;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(label)}</a></p>`;

// The frame every email shares: the Bazaar header, a heading, the content (already HTML) and a footer note.
const layout = (heading, content, footer) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px">
<div style="font-size:22px;font-weight:bold;color:#1e3a8a;margin-bottom:16px">Bazaar</div>
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>
${content}
<p style="font-size:12px;color:#6b7280">Bazaar · a demo store. ${escapeHtml(footer)}</p>
</div>
</body></html>`;

const SUBJECTS = {
  placed: 'confirmed',
  shipped: 'has shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

// Why a parcel came back (cod.js's RTO_REASONS, in the email's words; cod.js isn't imported, to keep imports one-way).
const RTO_TEXT = {
  refused: 'it was refused at the door',
  unreachable: 'the courier couldn’t reach you',
  address: 'the address was wrong or incomplete',
};

const CANCELLED_BY = {
  customer: 'Your order has been cancelled, as you asked.',
  admin: "We're sorry: we had to cancel your order.",
  system: "Your order was cancelled because the payment wasn't completed within 30 minutes.",
};

// The paragraphs that differ by event, as plain text (escaped when put into the HTML).
function intro(order, event) {
  const online = order.payment?.method === 'razorpay';
  if (event === 'placed') {
    if (!due(order)) return ['Thanks for your order! It is paid in full with your store credit.'];
    return online
      ? [`Thanks for your order! We've received your payment of ${rupees(due(order))}.`]
      : [`Thanks for your order! You'll pay ${rupees(due(order))} in cash when it arrives.`];
  }
  if (event === 'shipped') {
    const { courier, trackingNumber } = order.shipment ?? {};
    return [
      `Good news: your order is on its way to ${order.address.city}.`,
      ...(courier
        ? [`It's travelling with ${courier}${trackingNumber ? `, tracking number ${trackingNumber}` : ''}.`]
        : []),
    ];
  }
  if (event === 'delivered') return ['Your order has been delivered. We hope you like it!'];

  const lines = [
    order.returnedToSender
      ? `Your order came back to us undelivered (${RTO_TEXT[order.returnedToSender.reason] ?? 'it couldn’t be delivered'}), so we've cancelled it.`
      : (CANCELLED_BY[order.cancelledBy] ?? CANCELLED_BY.admin),
  ];
  const refund = order.payment?.status;
  if (refund === 'refunded' || refund === 'refunding') {
    lines.push(
      `We've started a refund of ${rupees(due(order))} to your original payment method. It usually reaches you in 5–7 working days.`,
    );
  } else if (refund === 'refund_failed') {
    lines.push(`Your refund of ${rupees(due(order))} is being processed. We'll take care of it.`);
  } else if (online) {
    lines.push('Nothing was charged.');
  }
  if (order.creditUsed) lines.push(`The ${rupees(order.creditUsed)} of store credit you used is back in your account.`);
  return lines;
}

// Builds { subject, text, html } for an order email. `user` is { name }; links point at `publicUrl`.
export function orderEmail(order, event, user, publicUrl = DEFAULT_PUBLIC_URL) {
  const subject = `Order #${orderNumber(order)} ${SUBJECTS[event]}`;
  const firstName = user.name.split(/\s+/)[0];
  const orderUrl = `${publicUrl}/orders/${order._id}`;
  // The courier's own tracking page, when the admin pasted one.
  const trackUrl = event === 'shipped' ? order.shipment?.trackingUrl || null : null;
  const paragraphs = intro(order, event);
  const items = order.items.map((i) => ({
    text: `${i.title} × ${i.qty}`,
    amount: rupees(i.price * i.qty),
    url: `${publicUrl}/p/${i.slug}`,
  }));
  const totals =
    event === 'placed'
      ? [
          ['Items', rupees(order.subtotal)],
          ['Delivery', order.delivery ? rupees(order.delivery) : 'Free'],
          ...(order.discount ? [[`Coupon ${order.coupon?.code ?? ''}`.trim(), `−${rupees(order.discount)}`]] : []),
          ['Total', rupees(order.total)],
          ...(order.creditUsed
            ? [
                ['Paid with store credit', `−${rupees(order.creditUsed)}`],
                [order.payment?.method === 'razorpay' ? 'Paid online' : 'To pay on delivery', rupees(due(order))],
              ]
            : []),
        ]
      : [];
  const a = order.address;
  const address =
    event === 'placed' || event === 'shipped'
      ? [a.name, a.line1, a.line2, `${a.city}, ${a.state} ${a.pincode}`, `Phone ${a.phone}`].filter(Boolean)
      : [];
  const reviewNote = event === 'delivered' ? 'Tell other shoppers what you think: open an item to review it.' : null;

  const text = [
    `Hi ${firstName},`,
    ...paragraphs,
    [
      ...items.map((i) => `- ${i.text}: ${i.amount}${event === 'delivered' ? ` (review: ${i.url})` : ''}`),
      ...totals.map(([label, value]) => `${label}: ${value}`),
    ].join('\n'),
    ...(reviewNote ? [reviewNote] : []),
    ...(address.length ? [`Delivering to:\n${address.join('\n')}`] : []),
    ...(trackUrl ? [`Track your parcel: ${trackUrl}`] : []),
    `View your order: ${orderUrl}`,
    'Bazaar · a demo store',
  ].join('\n\n');

  const cell = 'padding:6px 0;border-bottom:1px solid #e5e7eb';
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
<table style="width:100%;border-collapse:collapse;margin:16px 0">
${items
  .map(
    (i) =>
      `<tr><td style="${cell}">${event === 'delivered' ? `<a href="${escapeHtml(i.url)}" style="color:#2563eb">${escapeHtml(i.text)}</a>` : escapeHtml(i.text)}</td><td style="${cell};text-align:right">${i.amount}</td></tr>`,
  )
  .join('\n')}
${totals.map(([label, value]) => `<tr><td style="padding:4px 0">${label}</td><td style="padding:4px 0;text-align:right">${value}</td></tr>`).join('\n')}
</table>
${reviewNote ? `<p>${escapeHtml(reviewNote)}</p>` : ''}
${address.length ? `<p><strong>Delivering to</strong><br>${address.map(escapeHtml).join('<br>')}</p>` : ''}
${trackUrl ? button('Track your parcel', trackUrl) : ''}
${button('View your order', orderUrl)}`,
    "You're getting this email because you placed an order.",
  );

  return { subject, text, html };
}

export const RESET_LINK_MINUTES = 60;

// The password reset email. `url` carries the one-time token.
export function passwordResetEmail(user, url) {
  const subject = 'Reset your Bazaar password';
  const firstName = user.name.split(/\s+/)[0];
  const lines = [
    'Someone (hopefully you) asked to reset the password for your Bazaar account. Use this link to choose a new one:',
    `It works once, for the next ${RESET_LINK_MINUTES} minutes. If you didn't ask, ignore this email: your password stays the same.`,
  ];
  const text = [`Hi ${firstName},`, lines[0], url, lines[1], 'Bazaar · a demo store'].join('\n\n');
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
<p>${escapeHtml(lines[0])}</p>
${button('Choose a new password', url)}
<p>${escapeHtml(lines[1])}</p>`,
    "You're getting this email because a password reset was requested for your account.",
  );
  return { subject, text, html };
}

// "Back in stock" for a customer who asked to be told. `product` is the product document; `variant` the size or colour
// they asked about, if any.
export function backInStockEmail(user, product, publicUrl = DEFAULT_PUBLIC_URL, variant = null) {
  const name = variantTitle(product, variant);
  const { price, stock } = variant ?? product;
  const subject = `Back in stock: ${name}`;
  const firstName = user.name.split(/\s+/)[0];
  const url = `${publicUrl}/p/${product.slug}`;
  const lines = [
    `Good news: ${name} is back in stock at ${rupees(price)}.`,
    ...(stock <= 5 ? [`Only ${stock} left, so don't wait too long.`] : []),
    "We only email once. If it sells out again, ask again on the product's page.",
  ];
  const text = [`Hi ${firstName},`, ...lines, `See it: ${url}`, 'Bazaar · a demo store'].join('\n\n');
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
${lines
  .slice(0, -1)
  .map((l) => `<p>${escapeHtml(l)}</p>`)
  .join('\n')}
${button('View the product', url)}
<p>${escapeHtml(lines.at(-1))}</p>`,
    "You're getting this email because you asked to be told when this product was back.",
  );
  return { subject, text, html };
}

// A saved cart left alone for a day: what's in it at today's prices. `lines` are [{ product, variant, qty, price }].
export function cartReminderEmail(user, lines, publicUrl = DEFAULT_PUBLIC_URL) {
  const firstName = user.name.split(/\s+/)[0];
  const subject = 'You left something in your cart';
  const cartUrl = `${publicUrl}/cart`;
  const accountUrl = `${publicUrl}/account`;
  const rows = lines.map((l) => ({
    title: variantTitle(l.product, l.variant),
    text: `${l.qty > 1 ? `${l.qty} × ` : ''}${rupees(l.price)}`,
  }));
  const text = [
    `Hi ${firstName},`,
    'Your cart is saved, ready when you are:',
    rows.map((r) => `${r.title}: ${r.text}`).join('\n'),
    `Go to your cart: ${cartUrl}`,
    `Prices and stock can change until you order. We send this once per cart. To stop these emails, untick them on your account page: ${accountUrl}`,
    'Bazaar · a demo store',
  ].join('\n\n');
  const cell = 'padding:8px 0;border-bottom:1px solid #e5e7eb';
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
<p>Your cart is saved, ready when you are:</p>
<table style="width:100%;border-collapse:collapse;margin:8px 0 16px">
${rows.map((r) => `<tr><td style="${cell}">${escapeHtml(r.title)}</td><td style="${cell};text-align:right;white-space:nowrap">${escapeHtml(r.text)}</td></tr>`).join('\n')}
</table>
${button('Go to your cart', cartUrl)}
<p style="font-size:13px;color:#6b7280">Prices and stock can change until you order. To stop these emails, untick them on <a href="${escapeHtml(accountUrl)}">your account page</a>.</p>`,
    "You're getting this email because you left items in your cart a day ago.",
  );
  return { subject, text, html };
}

// Products on a customer's wishlist got cheaper: `items` are [{ product, from, to }] (paise; `from` is the price they
// last saw). One email for all of them.
export function priceDropEmail(user, items, publicUrl = DEFAULT_PUBLIC_URL) {
  const firstName = user.name.split(/\s+/)[0];
  const only = items.length === 1 ? items[0] : null;
  const subject = only
    ? `Price drop: ${only.product.title} is now ${rupees(only.to)}`
    : `Price drops on ${items.length} items on your wishlist`;
  const percent = (i) => Math.round(((i.from - i.to) / i.from) * 100);
  const lines = items.map((i) => ({
    title: i.product.title,
    url: `${publicUrl}/p/${i.product.slug}`,
    text: `${rupees(i.from)} → ${i.product.variants?.some((v) => v.price !== i.product.price) ? 'from ' : ''}${rupees(i.to)} (${percent(i)}% less)`,
  }));
  const wishlistUrl = `${publicUrl}/wishlist`;
  const accountUrl = `${publicUrl}/account`;
  const intro = only ? 'Something on your wishlist is cheaper now:' : 'Some things on your wishlist are cheaper now:';
  const text = [
    `Hi ${firstName},`,
    intro,
    lines.map((l) => `${l.title}: ${l.text}\n${l.url}`).join('\n\n'),
    `Your wishlist: ${wishlistUrl}`,
    `Prices can change again, and we email at most once per drop. To stop these emails, untick them on your account page: ${accountUrl}`,
    'Bazaar · a demo store',
  ].join('\n\n');
  const cell = 'padding:8px 0;border-bottom:1px solid #e5e7eb';
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
<p>${escapeHtml(intro)}</p>
<table style="width:100%;border-collapse:collapse;margin:8px 0 16px">
${lines.map((l) => `<tr><td style="${cell}"><a href="${escapeHtml(l.url)}" style="color:#1d4ed8">${escapeHtml(l.title)}</a></td><td style="${cell};text-align:right;white-space:nowrap">${escapeHtml(l.text)}</td></tr>`).join('\n')}
</table>
${button('See your wishlist', wishlistUrl)}
<p style="font-size:13px;color:#6b7280">To stop these emails, untick them on <a href="${escapeHtml(accountUrl)}">your account page</a>.</p>`,
    "You're getting this email because these products are on your wishlist.",
  );
  return { subject, text, html };
}

// The asker's question has its first answer. `question` is the stored document, `product` { title, slug }.
export function questionAnsweredEmail(user, question, product, publicUrl = DEFAULT_PUBLIC_URL) {
  const subject = `Your question about ${product.title} was answered`;
  const firstName = user.name.split(/\s+/)[0];
  const url = `${publicUrl}/p/${product.slug}#questions`;
  const text = [
    `Hi ${firstName},`,
    `You asked: ${question.text}`,
    `Our answer: ${question.answer.text}`,
    `See it on the product page: ${url}`,
    'Bazaar · a demo store',
  ].join('\n\n');
  const quote = 'margin:0 0 12px;padding:10px 14px;background:#f3f4f6;border-radius:6px;white-space:pre-wrap';
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
<p style="margin-bottom:4px">You asked:</p>
<p style="${quote}">${escapeHtml(question.text)}</p>
<p style="margin-bottom:4px">Our answer:</p>
<p style="${quote}">${escapeHtml(question.answer.text)}</p>
${button('See it on the product page', url)}`,
    "You're getting this email because you asked a question about this product.",
  );
  return { subject, text, html };
}

// Emails the asker the first answer to their question. Never throws: the answer is already saved.
export async function sendQuestionAnswered(ctx, question, product) {
  try {
    if (!product) return;
    const user = await ctx.db
      .collection('users')
      .findOne({ _id: question.userId }, { projection: { name: 1, email: 1 } });
    if (!user) return;
    const email = questionAnsweredEmail(user, question, product, ctx.config.mail?.publicUrl);
    await ctx.mail.send({ to: { email: user.email, name: user.name }, ...email });
  } catch (err) {
    console.error(`Could not send the answer to question ${question._id}:`, err.message);
  }
}

export const EMAIL_CHANGE_HOURS = 24;

// Sent to the new address: the one-time link that confirms it. `url` carries the token.
export function confirmEmailChangeEmail(user, newEmail, url) {
  const subject = 'Confirm your new Bazaar email';
  const firstName = user.name.split(/\s+/)[0];
  const lines = [
    `You asked to change the email for your Bazaar account to ${newEmail}. Confirm it with this link:`,
    `It works once, for the next ${EMAIL_CHANGE_HOURS} hours. Until then you keep logging in with ${user.email}. If you didn't ask, ignore this email: nothing changes.`,
  ];
  const text = [`Hi ${firstName},`, lines[0], url, lines[1], 'Bazaar · a demo store'].join('\n\n');
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
<p>${escapeHtml(lines[0])}</p>
${button('Confirm this email', url)}
<p>${escapeHtml(lines[1])}</p>`,
    "You're getting this email because someone asked to use this address for a Bazaar account.",
  );
  return { subject, text, html };
}

// Sent to the old address once the change is done, so a change the owner didn't make doesn't go unnoticed.
export function emailChangedEmail(user, oldEmail, newEmail) {
  const subject = 'Your Bazaar email was changed';
  const firstName = user.name.split(/\s+/)[0];
  const lines = [
    `The email for your Bazaar account was changed from ${oldEmail} to ${newEmail}. You now log in with the new one, and order emails go there.`,
    "If you didn't make this change, reply to this email so we can secure your account.",
  ];
  const text = [`Hi ${firstName},`, ...lines, 'Bazaar · a demo store'].join('\n\n');
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')}`,
    "You're getting this email because it was the address of a Bazaar account.",
  );
  return { subject, text, html };
}

// Sent to an admin whose account just logged in from a browser it hasn't used before (loginAlerts.js). `login` is
// { at, browser, ip }; the time is written in India time.
export function newLoginEmail(user, login, publicUrl = DEFAULT_PUBLIC_URL) {
  const subject = 'New login to your Bazaar admin account';
  const firstName = user.name.split(/\s+/)[0];
  const when = login.at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const details = [
    ['When', `${when} (India time)`],
    ['Browser', login.browser],
    ['IP address', login.ip],
  ];
  const lines = [
    `Your admin account (${user.email}) just logged in from a browser it hasn't used before.`,
    "If it was you (a new device, another browser, or after clearing cookies), there's nothing to do.",
    'If it wasn\'t you, someone knows your password: change it now from your account page, which logs out every other browser, and turn on two-step login there. If you can\'t log in, use "Forgot password" on the login page.',
  ];
  const url = `${publicUrl}/account`;
  const text = [
    `Hi ${firstName},`,
    lines[0],
    details.map(([k, v]) => `${k}: ${v}`).join('\n'),
    lines[1],
    lines[2],
    url,
    'Bazaar · a demo store',
  ].join('\n\n');
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
<p>${escapeHtml(lines[0])}</p>
<table style="border-collapse:collapse;margin:0 0 16px">${details
      .map(
        ([k, v]) =>
          `<tr><td style="padding:2px 12px 2px 0;color:#6b7280">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`,
      )
      .join('')}</table>
<p>${escapeHtml(lines[1])}</p>
<p>${escapeHtml(lines[2])}</p>
${button('Open my account', url)}`,
    "You're getting this email because you're an admin of the store, and admin accounts are told about every new browser.",
  );
  return { subject, text, html };
}

const PAYMENT_NAMES = { cod: 'Cash on Delivery', razorpay: 'Paid online', credit: 'Paid with store credit' };

// "New order" for the admins: who ordered, what, the total and how it's paid, and a link to it in the admin panel.
// `customer` is { name, email }, or null if the account is gone.
export function newOrderEmail(order, customer, publicUrl = DEFAULT_PUBLIC_URL) {
  const payment = PAYMENT_NAMES[order.payment?.method ?? order.payment] ?? 'Cash on Delivery';
  const subject = `New order #${orderNumber(order)}: ${rupees(order.total)} (${payment})`;
  const url = `${publicUrl}/admin/orders/${order._id}`;
  const a = order.address;
  const who = customer ? `${customer.name} (${customer.email})` : a.name;
  const items = order.items.map((i) => [`${i.title} × ${i.qty}`, rupees(i.price * i.qty)]);
  const totals = [
    ['Delivery', order.delivery ? rupees(order.delivery) : 'Free'],
    ...(order.discount ? [[`Coupon ${order.coupon?.code ?? ''}`.trim(), `−${rupees(order.discount)}`]] : []),
    ['Total', rupees(order.total)],
    ...(order.creditUsed ? [['Store credit used', `−${rupees(order.creditUsed)}`]] : []),
  ];
  const lines = [`${who} placed an order. ${payment}.`, `Deliver to ${a.city}, ${a.state} ${a.pincode}.`];

  const text = [
    ...lines,
    [...items, ...totals].map(([label, value]) => `${label}: ${value}`).join('\n'),
    `Open it in the admin panel: ${url}`,
    'Bazaar · a demo store',
  ].join('\n\n');

  const cell = 'padding:6px 0;border-bottom:1px solid #e5e7eb';
  const html = layout(
    subject,
    `${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')}
<table style="width:100%;border-collapse:collapse;margin:16px 0">
${items.map(([label, value]) => `<tr><td style="${cell}">${escapeHtml(label)}</td><td style="${cell};text-align:right">${value}</td></tr>`).join('\n')}
${totals.map(([label, value]) => `<tr><td style="padding:4px 0">${escapeHtml(label)}</td><td style="padding:4px 0;text-align:right">${value}</td></tr>`).join('\n')}
</table>
${button('Open the order', url)}`,
    "You're getting this email because you're an admin of the store.",
  );
  return { subject, text, html };
}

// The morning list of products running out, for the admins. `products` are from lowStockProducts() (lowest first, at
// most a page of them) and `total` is how many there are in all.
// `soon` (stage 75, reorder.js): { items, total } of products and options running out within RUNOUT_DAYS at their
// recent sales, listed after the low ones with how many to order; either list may be empty, not both.
export function lowStockEmail(products, total, publicUrl = DEFAULT_PUBLIC_URL, soon = { items: [], total: 0 }) {
  const soldOut = products.filter((p) => p.stock === 0).length;
  const plural = (n) => `${n} product${n === 1 ? '' : 's'}`;
  const subject = total
    ? `Low stock: ${plural(total)} to restock${soldOut ? ` (${soldOut} sold out)` : ''}${soon.total ? `, ${soon.total} running out soon` : ''}`
    : `Running out soon: ${plural(soon.total)} at recent sales`;
  const url = `${publicUrl}/admin/products?status=low`;
  const soonRows = soon.items.map((r) => ({
    title: r.label ? `${r.title} (${r.label})` : r.title,
    detail: `${r.stock} left, sells about ${r.perDay} a day${r.suggest ? `; order about ${r.suggest} for a month` : ''}`,
    left: r.daysLeft === 0 ? 'today' : `${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'}`,
  }));
  const soonIntro = 'Running out within two weeks at the last month’s sales:';
  const soonMore = soon.total > soon.items.length ? `And ${soon.total - soon.items.length} more.` : '';
  const left = (stock) => (stock === 0 ? 'sold out' : `${stock} left`);
  const rows = products.map((p) => ({
    title: p.title,
    detail: p.variants.map((v) => `${v.label}: ${left(v.stock)}`).join(' · '),
    left: left(p.stock),
  }));
  const more = total > products.length ? `And ${total - products.length} more.` : '';
  const intro = 'These products in the store have 5 or fewer left.';

  const text = [
    ...(total ? [intro, rows.map((r) => `${r.title}: ${r.left}${r.detail ? ` (${r.detail})` : ''}`).join('\n')] : []),
    ...(more ? [more] : []),
    ...(soon.total
      ? [
          soonIntro,
          soonRows.map((r) => `${r.title}: ${r.left} (${r.detail})`).join('\n'),
          ...(soonMore ? [soonMore] : []),
        ]
      : []),
    `See them in the admin panel: ${url}`,
    'Bazaar · a demo store',
  ].join('\n\n');

  const cell = 'padding:6px 0;border-bottom:1px solid #e5e7eb;vertical-align:top';
  const html = layout(
    subject,
    `${
      total
        ? `<p>${escapeHtml(intro)}</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
${rows
  .map(
    (r) =>
      `<tr><td style="${cell}">${escapeHtml(r.title)}${r.detail ? `<br><span style="font-size:13px;color:#6b7280">${escapeHtml(r.detail)}</span>` : ''}</td><td style="${cell};text-align:right;white-space:nowrap${r.left === 'sold out' ? ';color:#b91c1c' : ''}">${r.left}</td></tr>`,
  )
  .join('\n')}
</table>
${more ? `<p>${escapeHtml(more)}</p>` : ''}`
        : ''
    }
${
  soon.total
    ? `<p>${escapeHtml(soonIntro)}</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
${soonRows
  .map(
    (r) =>
      `<tr><td style="${cell}">${escapeHtml(r.title)}<br><span style="font-size:13px;color:#6b7280">${escapeHtml(r.detail)}</span></td><td style="${cell};text-align:right;white-space:nowrap">${r.left}</td></tr>`,
  )
  .join('\n')}
</table>
${soonMore ? `<p>${escapeHtml(soonMore)}</p>` : ''}`
    : ''
}
${button('Open low stock', url)}`,
    "You're getting this email each morning because you're an admin of the store and some products are running low.",
  );
  return { subject, text, html };
}

// The admins' weekly note (weeklyNote.js): Claude's paragraphs about last week (or null when they couldn't be written)
// and the figures they came from, as [label, value] lines. The subject is built from the figures, never by Claude.
export function weeklyNoteEmail(figures, facts, paragraphs, publicUrl = DEFAULT_PUBLIC_URL) {
  const day = (iso) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const week = `${day(figures.from)} to ${day(figures.to)}`;
  const subject = `Your week at Bazaar: ${rupees(figures.revenue)} from ${figures.orders} order${figures.orders === 1 ? '' : 's'} (${week})`;
  const url = `${publicUrl}/admin?days=7`;
  const intro = paragraphs?.length
    ? paragraphs
    : ["This week's note couldn't be written, so here are the figures on their own."];
  const figuresNote = paragraphs?.length
    ? 'Written by Claude from the figures below, which come straight from the store: check anything that matters against them.'
    : '';

  const text = [
    ...intro,
    ...(figuresNote ? [figuresNote] : []),
    facts.map(([label, value]) => `${label}: ${value}`).join('\n'),
    `Open the dashboard: ${url}`,
    'Bazaar · a demo store',
  ].join('\n\n');

  const cell = 'padding:6px 0;border-bottom:1px solid #e5e7eb;vertical-align:top';
  const html = layout(
    subject,
    `${intro.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
${figuresNote ? `<p style="font-size:13px;color:#6b7280">${escapeHtml(figuresNote)}</p>` : ''}
<table style="width:100%;border-collapse:collapse;margin:16px 0">
${facts.map(([label, value]) => `<tr><td style="${cell};padding-right:12px;color:#6b7280;white-space:nowrap">${escapeHtml(label)}</td><td style="${cell}">${escapeHtml(value)}</td></tr>`).join('\n')}
</table>
${button('Open the dashboard', url)}`,
    "You're getting this email each Monday because you're an admin of the store. Switch it off on the dashboard.",
  );
  return { subject, text, html };
}

// Sent to the address of an account that was just closed (routes/accountData.js), so a closure the owner didn't make
// doesn't go unnoticed.
export function accountClosedEmail(user) {
  const subject = 'Your Bazaar account was closed';
  const firstName = user.name.split(/\s+/)[0];
  const lines = [
    'Your Bazaar account was closed, as asked. Your details, addresses, wishlist and reviews have been deleted. We keep your past orders for tax records, without your name, phone or street.',
    "If you didn't close it, reply to this email straight away. You're welcome to make a new account with this address at any time.",
  ];
  const text = [`Hi ${firstName},`, ...lines, 'Bazaar · a demo store'].join('\n\n');
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')}`,
    "You're getting this email because it was the address of a Bazaar account.",
  );
  return { subject, text, html };
}

// For the admins: a new help request, or a customer writing again (`followUp`), with the message and a link to the
// Help inbox. `order` is { number } of the order it's about, or null.
export function helpRequestEmail(request, order, followUp, publicUrl = DEFAULT_PUBLIC_URL) {
  const last = request.messages.at(-1);
  const about = order ? ` about order #${orderNumber(order)}` : '';
  const subject = followUp
    ? `Help request #${request.number}: ${request.name} wrote again`
    : `Help request #${request.number} from ${request.name}${about}`;
  const url = `${publicUrl}/admin/help`;
  const who = `${request.name} (${request.email})${request.userId ? '' : ', not logged in'}`;
  const text = [
    `${who}${followUp ? ' wrote again' : ' asked for help'}${about}:`,
    last.text,
    `Answer in the admin panel: ${url}`,
    'Bazaar · a demo store',
  ].join('\n\n');
  const html = layout(
    subject,
    `<p>${escapeHtml(`${who}${followUp ? ' wrote again' : ' asked for help'}${about}:`)}</p>
<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #e5e7eb;white-space:pre-wrap">${escapeHtml(last.text)}</blockquote>
${button('Answer it', url)}`,
    "You're getting this email because you're an admin of the store.",
  );
  return { subject, text, html };
}

// For the customer: the store's reply to their help request, with their message below it. Logged-in customers get a
// link to the conversation; guests answer by writing a new request.
export function helpReplyEmail(request, reply, publicUrl = DEFAULT_PUBLIC_URL) {
  const firstName = request.name.split(/\s+/)[0];
  const subject = `Re: your help request #${request.number}`;
  const asked = [...request.messages].reverse().find((m) => m.from === 'customer');
  const url = request.userId ? `${publicUrl}/help/${request._id}` : `${publicUrl}/help`;
  const linkText = request.userId ? 'See the conversation' : 'Write to us again';
  const text = [
    `Hi ${firstName},`,
    reply,
    `You wrote: "${asked?.text ?? ''}"`,
    request.userId ? `To reply, open the conversation: ${url}` : `To reply, write to us again: ${url}`,
    'Bazaar · a demo store',
  ].join('\n\n');
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
<p style="white-space:pre-wrap">${escapeHtml(reply)}</p>
<p style="font-size:13px;color:#6b7280">You wrote:</p>
<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #e5e7eb;color:#6b7280;white-space:pre-wrap">${escapeHtml(asked?.text ?? '')}</blockquote>
${button(linkText, url)}`,
    "You're getting this email because you asked Bazaar for help.",
  );
  return { subject, text, html };
}

// Who hears about store events (new orders, return requests): ADMIN_EMAIL if set, otherwise every admin account.
export async function adminRecipients(ctx) {
  const configured = ctx.config.mail?.adminEmails ?? [];
  if (configured.length) return configured.map((email) => ({ email }));
  const admins = await ctx.db
    .collection('users')
    .find({ role: 'admin' }, { projection: { name: 1, email: 1 } })
    .toArray();
  return admins.map((u) => ({ email: u.email, name: u.name }));
}

// Sends `email` to each admin separately, so one failed address doesn't stop the rest. Never throws.
export async function sendToAdmins(ctx, email, what) {
  try {
    for (const to of await adminRecipients(ctx)) {
      try {
        await ctx.mail.send({ to, ...email });
      } catch (err) {
        console.error(`Could not send ${what}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`Could not send ${what}:`, err.message);
  }
}

// Tells the admins about an order that has just been placed (COD at checkout, online once paid). Goes to ADMIN_EMAIL if
// set, otherwise to every admin account. Never throws, and one failed address doesn't stop the others.
export async function sendNewOrderAlert(ctx, order) {
  try {
    const customer = await ctx.db
      .collection('users')
      .findOne({ _id: order.userId }, { projection: { name: 1, email: 1 } });
    await sendToAdmins(
      ctx,
      newOrderEmail(order, customer, ctx.config.mail?.publicUrl),
      `the new-order alert for order ${order._id}`,
    );
  } catch (err) {
    console.error(`Could not send the new-order alert for order ${order._id}:`, err.message);
  }
}

export const RETURN_REASONS = {
  damaged: 'Arrived damaged or faulty',
  wrong_item: 'Wrong item sent',
  not_as_described: "Doesn't match the description",
  changed_mind: 'Changed my mind',
  other: 'Other',
};
const returnLines = (ret) => ret.items.map((i) => [`${i.title} × ${i.qty}`, rupees(i.price * i.qty)]);

// "Return requested" for the admins: who, which order and items, why, the refund it would mean, and a link to it.
export function returnRequestedEmail(ret, order, customer, publicUrl = DEFAULT_PUBLIC_URL) {
  const subject = `Return requested for order #${orderNumber(order)}: ${rupees(ret.refund)}`;
  const url = `${publicUrl}/admin/returns`;
  const who = customer ? `${customer.name} (${customer.email})` : order.address.name;
  const lines = [
    `${who} asked to return items from order #${orderNumber(order)}.`,
    `Reason: ${RETURN_REASONS[ret.reason]}${ret.note ? `: ${ret.note}` : ''}`,
  ];
  const items = returnLines(ret);
  const text = [
    ...lines,
    [...items, ['Refund if approved', rupees(ret.refund)]].map(([l, v]) => `${l}: ${v}`).join('\n'),
    `Approve or decline it in the admin panel: ${url}`,
    'Bazaar · a demo store',
  ].join('\n\n');
  const cell = 'padding:6px 0;border-bottom:1px solid #e5e7eb';
  const html = layout(
    subject,
    `${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')}
<table style="width:100%;border-collapse:collapse;margin:16px 0">
${items.map(([l, v]) => `<tr><td style="${cell}">${escapeHtml(l)}</td><td style="${cell};text-align:right">${v}</td></tr>`).join('\n')}
<tr><td style="padding:4px 0">Refund if approved</td><td style="padding:4px 0;text-align:right">${rupees(ret.refund)}</td></tr>
</table>
${button('Review the return', url)}`,
    "You're getting this email because you're an admin of the store.",
  );
  return { subject, text, html };
}

// The customer's email when a return is approved (with how the money comes back) or declined (with the reason).
export function returnDecisionEmail(ret, order, user, publicUrl = DEFAULT_PUBLIC_URL) {
  const approved = ret.status !== 'declined';
  const subject = `Your return for order #${orderNumber(order)} was ${approved ? 'approved' : 'declined'}`;
  const firstName = user.name.split(/\s+/)[0];
  const orderUrl = `${publicUrl}/orders/${order._id}`;
  const online = ret.refundMethod === 'razorpay';
  const credit = ret.refundCredit ?? 0;
  const money = ret.refund - credit;
  const lines = approved
    ? [
        "We've accepted your return.",
        ...(credit ? [`${rupees(credit)} is back in your account as store credit, ready to use at checkout.`] : []),
        ...(!money
          ? []
          : online
            ? [
                `We've started a refund of ${rupees(money)} to your original payment method. It usually reaches you in 5–7 working days.`,
              ]
            : [
                `You paid in cash, so we'll refund ${rupees(money)} to you directly (UPI or bank transfer) and get in touch for the details.`,
              ]),
      ]
    : ["We're sorry: we can't accept your return.", ...(ret.declineReason ? [`Why: ${ret.declineReason}`] : [])];
  const items = returnLines(ret);
  const text = [
    `Hi ${firstName},`,
    ...lines,
    items.map(([l, v]) => `- ${l}: ${v}`).join('\n'),
    `View your order: ${orderUrl}`,
    'Bazaar · a demo store',
  ].join('\n\n');
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')}
<ul>${items.map(([l, v]) => `<li>${escapeHtml(l)}: ${v}</li>`).join('')}</ul>
${button('View your order', orderUrl)}`,
    "You're getting this email because you asked to return items.",
  );
  return { subject, text, html };
}

export async function sendReturnRequestAlert(ctx, ret, order) {
  try {
    const customer = await ctx.db
      .collection('users')
      .findOne({ _id: order.userId }, { projection: { name: 1, email: 1 } });
    await sendToAdmins(
      ctx,
      returnRequestedEmail(ret, order, customer, ctx.config.mail?.publicUrl),
      `the return alert for ${ret._id}`,
    );
  } catch (err) {
    console.error(`Could not send the return alert for ${ret._id}:`, err.message);
  }
}

// Emails the customer the decision on their return. Never throws: the decision is already saved.
export async function sendReturnDecision(ctx, ret, order) {
  try {
    const user = await ctx.db.collection('users').findOne({ _id: order.userId }, { projection: { name: 1, email: 1 } });
    if (!user) return;
    const email = returnDecisionEmail(ret, order, user, ctx.config.mail?.publicUrl);
    await ctx.mail.send({ to: { email: user.email, name: user.name }, ...email });
  } catch (err) {
    console.error(`Could not send the return decision for ${ret._id}:`, err.message);
  }
}

// Emails the order's customer about `event`. Never throws: the order change it reports is already saved.
export async function sendOrderEmail(ctx, order, event) {
  try {
    const user = await ctx.db.collection('users').findOne({ _id: order.userId }, { projection: { name: 1, email: 1 } });
    if (!user) return;
    const email = orderEmail(order, event, user, ctx.config.mail?.publicUrl);
    await ctx.mail.send({ to: { email: user.email, name: user.name }, ...email });
  } catch (err) {
    console.error(`Could not send the ${event} email for order ${order._id}:`, err.message);
  }
}

// For a customer given store credit by the store (credit.js): how much, why, and what they now have.
export function creditAddedEmail(user, { amount, note, balance }, publicUrl = DEFAULT_PUBLIC_URL) {
  const firstName = user.name.split(/\s+/)[0];
  const subject = `${rupees(amount)} of store credit for you`;
  const url = `${publicUrl}/account#credit`;
  const lines = [
    `We've added ${rupees(amount)} of store credit to your Bazaar account.`,
    `Why: ${note}`,
    `You now have ${rupees(balance)} to use at checkout. It doesn't expire.`,
  ];
  const text = [`Hi ${firstName},`, ...lines, `See it in your account: ${url}`, 'Bazaar · a demo store'].join('\n\n');
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')}
${button('See my store credit', url)}`,
    "You're getting this email because the store added credit to your account.",
  );
  return { subject, text, html };
}

// ---- Gift cards (stage 77, giftCards.js) ----

const longDate = (d) =>
  new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

// For the recipient: who it's from, their message, the code and how to use it.
export function giftCardEmail(card, code, publicUrl = DEFAULT_PUBLIC_URL) {
  const firstName = card.recipient.name.split(/\s+/)[0];
  const subject = `${card.buyerName} sent you a ${rupees(card.amount)} Bazaar gift card`;
  const url = `${publicUrl}/gift-cards`;
  const lines = [
    `${card.buyerName} sent you a gift card for ${rupees(card.amount)} to spend at Bazaar.`,
    ...(card.message ? [`"${card.message}"`] : []),
    `Your code: ${code}`,
    `To use it, log in (or make an account) and enter the code under Gift cards: it becomes store credit, used at checkout. Redeem it by ${longDate(card.expiresAt)}.`,
  ];
  const text = [`Hi ${firstName},`, ...lines, `Redeem it here: ${url}`, 'Bazaar · a demo store'].join('\n\n');
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
<p>${escapeHtml(lines[0])}</p>
${card.message ? `<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #e5e7eb;white-space:pre-wrap">${escapeHtml(card.message)}</blockquote>` : ''}
<p style="font-size:22px;font-weight:700;letter-spacing:2px;font-family:monospace">${escapeHtml(code)}</p>
<p>${escapeHtml(lines.at(-1))}</p>
${button('Redeem it', url)}`,
    `You're getting this email because ${card.buyerName} sent you a gift card.`,
  );
  return { subject, text, html };
}

// For the buyer: the receipt, when it goes, and a copy of the code in case the recipient's email goes astray.
export function giftCardReceiptEmail(card, code, publicUrl = DEFAULT_PUBLIC_URL) {
  const subject = `Your ${rupees(card.amount)} gift card for ${card.recipient.name}`;
  const url = `${publicUrl}/gift-cards`;
  const when =
    card.status === 'scheduled'
      ? `We'll email it to ${card.recipient.email} on ${longDate(card.sendAt)}.`
      : `We've emailed it to ${card.recipient.email}.`;
  const lines = [
    `Thanks! You paid ${rupees(card.amount)} for a gift card for ${card.recipient.name}.`,
    when,
    `A copy of the code, in case their email goes astray: ${code}. It can be redeemed until ${longDate(card.expiresAt)}.`,
  ];
  const text = [...lines, `Your gift cards: ${url}`, 'Bazaar · a demo store'].join('\n\n');
  const html = layout(
    subject,
    `${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')}
${button('Your gift cards', url)}`,
    "You're getting this email because you bought a gift card.",
  );
  return { subject, text, html };
}

// For a recipient who hasn't redeemed it: it runs out soon. The code isn't kept, so it points to the first email.
export function giftCardReminderEmail(card, publicUrl = DEFAULT_PUBLIC_URL) {
  const firstName = card.recipient.name.split(/\s+/)[0];
  const subject = `Your Bazaar gift card runs out on ${longDate(card.expiresAt)}`;
  const url = `${publicUrl}/gift-cards`;
  const line = `The ${rupees(card.amount)} gift card ${card.buyerName} sent you hasn't been redeemed yet. The code is in our email from ${longDate(card.sentAt)}; redeem it by ${longDate(card.expiresAt)}.`;
  const text = [`Hi ${firstName},`, line, `Redeem it here: ${url}`, 'Bazaar · a demo store'].join('\n\n');
  const html = layout(
    subject,
    `<p>Hi ${escapeHtml(firstName)},</p>
<p>${escapeHtml(line)}</p>
${button('Redeem it', url)}`,
    `You're getting this email because ${card.buyerName} sent you a gift card.`,
  );
  return { subject, text, html };
}

// For the buyer: the store cancelled their card (not redeemed) and refunds it.
export function giftCardCancelledEmail(card) {
  const subject = `Your ${rupees(card.amount)} gift card was cancelled`;
  const refund =
    card.payment.status === 'refunded'
      ? `We've started a refund of ${rupees(card.amount)} to your original payment method. It usually reaches you in 5–7 working days.`
      : `Your refund of ${rupees(card.amount)} is being processed. We'll take care of it.`;
  const lines = [`We've cancelled the gift card for ${card.recipient.name}; its code no longer works.`, refund];
  const text = [...lines, 'Bazaar · a demo store'].join('\n\n');
  const html = layout(
    subject,
    lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n'),
    "You're getting this email because you bought a gift card.",
  );
  return { subject, text, html };
}
