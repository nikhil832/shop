// Customer emails: order confirmed (placed), shipped, delivered and cancelled, sent after the change is saved (a failure
// is logged and never undoes or fails the change itself), and the password reset link.

const DEFAULT_PUBLIC_URL = 'http://localhost:5173';

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
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

const CANCELLED_BY = {
  customer: 'Your order has been cancelled, as you asked.',
  admin: "We're sorry: we had to cancel your order.",
  system: "Your order was cancelled because the payment wasn't completed within 30 minutes.",
};

// The paragraphs that differ by event, as plain text (escaped when put into the HTML).
function intro(order, event) {
  const online = order.payment?.method === 'razorpay';
  if (event === 'placed') {
    return online
      ? [`Thanks for your order! We've received your payment of ${rupees(order.total)}.`]
      : [`Thanks for your order! You'll pay ${rupees(order.total)} in cash when it arrives.`];
  }
  if (event === 'shipped') return [`Good news: your order is on its way to ${order.address.city}.`];
  if (event === 'delivered') return ['Your order has been delivered. We hope you like it!'];

  const lines = [CANCELLED_BY[order.cancelledBy] ?? CANCELLED_BY.admin];
  const refund = order.payment?.status;
  if (refund === 'refunded' || refund === 'refunding') {
    lines.push(
      `We've started a refund of ${rupees(order.total)} to your original payment method. It usually reaches you in 5–7 working days.`,
    );
  } else if (refund === 'refund_failed') {
    lines.push(`Your refund of ${rupees(order.total)} is being processed. We'll take care of it.`);
  } else if (online) {
    lines.push('Nothing was charged.');
  }
  return lines;
}

// Builds { subject, text, html } for an order email. `user` is { name }; links point at `publicUrl`.
export function orderEmail(order, event, user, publicUrl = DEFAULT_PUBLIC_URL) {
  const subject = `Order #${orderNumber(order)} ${SUBJECTS[event]}`;
  const firstName = user.name.split(/\s+/)[0];
  const orderUrl = `${publicUrl}/orders/${order._id}`;
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
          ['Total', rupees(order.total)],
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
