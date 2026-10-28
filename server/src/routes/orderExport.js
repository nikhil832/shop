import express from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { HttpError, parse } from '../http.js';
import { ORDER_STATUSES } from './orders.js';
import { REFUNDED_RETURNS, SOLD } from './dashboard.js';
import { findState, gstCreditNote, gstInvoice } from '../gst.js';

// Days are India time, like the dashboard (a fixed +5:30, no daylight saving).
const IST_OFFSET = 330 * 60_000;
const DAY = 86_400_000;
const MAX_DAYS = 366;
const MAX_ROWS = 20_000;

const day = z.string('Choose a date').regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date');
const exportQuery = z.object({
  from: day,
  to: day,
  status: z
    .enum(ORDER_STATUSES)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  // `orders`: one row per order; `gst`: tax by place of supply and rate, for the GST return.
  report: z.enum(['orders', 'gst'], 'Choose a report').default('orders'),
});

// Midnight India time at the start of `date` ("2026-10-23"), or null for a date that doesn't exist.
function istMidnight(date) {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date) return null;
  return time - IST_OFFSET;
}

// "2026-10-23 14:05" in India time.
const istDateTime = (date) => new Date(date.getTime() + IST_OFFSET).toISOString().slice(0, 16).replace('T', ' ');
// Paise as rupees with two decimals, which spreadsheets read as numbers.
const rupees = (paise) => (paise / 100).toFixed(2);

// One CSV cell. Text a customer typed could start with a formula character (= + - @), which a spreadsheet would run:
// a leading ' keeps it text. Cells with commas, quotes or line breaks are quoted.
export function cell(value, { text = false } = {}) {
  let s = value == null ? '' : String(value);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const PAYMENT = { razorpay: 'Online', cod: 'Cash on Delivery', credit: 'Store credit' };

const COLUMNS = [
  'Order',
  'Date (India time)',
  'Status',
  'Customer',
  'Email',
  'Items',
  'Item details',
  'Items total (₹)',
  'Delivery (₹)',
  'Discount (₹)',
  'Coupon',
  'Total (₹)',
  'Refunded (₹)',
  'Net total (₹)',
  // Orders placed while GST was on (gst.js); empty for the others.
  'Place of supply',
  'Taxable value (₹)',
  'CGST (₹)',
  'SGST (₹)',
  'IGST (₹)',
  'Payment',
  'Payment status',
  // Paid with store credit (stage 72); the total less this was paid in money.
  'Store credit (₹)',
  // What the items cost the store (stage 80), when every item had a cost price; else empty.
  'Item cost (₹)',
  'City',
  'State',
  'PIN code',
  'Courier',
  'Tracking number',
];

const GST_COLUMNS = [
  'Place of supply',
  'State code',
  'GST rate (%)',
  'Orders',
  'Credit notes',
  'Taxable value (₹)',
  'CGST (₹)',
  'SGST (₹)',
  'IGST (₹)',
  'Total tax (₹)',
];

// The GST summary: sold orders (placed, shipped or delivered) placed with GST on, added up per place of supply and rate
// from their invoices' lines, less the credit notes of returns issued in the same dates (whenever their order was
// placed), which is how B2C sales are reported in the GST return: net of credit notes, in the period they're issued.
// `credited` is [{ order, ret }].
function gstSummaryRows(docs, credited) {
  const groups = new Map();
  function add(doc, sign, key) {
    for (const r of doc.byRate) {
      const id = `${doc.placeOfSupply.name}|${r.rate}`;
      const g = groups.get(id) ?? {
        place: doc.placeOfSupply.name,
        code: doc.placeOfSupply.code ?? findState(doc.placeOfSupply.name)?.code ?? '',
        rate: r.rate,
        orders: new Set(),
        creditNotes: new Set(),
        taxable: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
      };
      g[sign > 0 ? 'orders' : 'creditNotes'].add(key);
      for (const k of ['taxable', 'cgst', 'sgst', 'igst']) g[k] += sign * r[k];
      groups.set(id, g);
    }
  }
  for (const o of docs) {
    const inv = gstInvoice(o);
    if (inv && SOLD.includes(o.status)) add(inv, 1, o._id.toString());
  }
  for (const { order, ret } of credited) {
    const note = gstCreditNote(order, ret);
    if (note) add(note, -1, ret._id.toString());
  }
  return [...groups.values()]
    .sort((a, b) => a.place.localeCompare(b.place) || a.rate - b.rate)
    .map((g) =>
      [
        cell(g.place, { text: true }),
        cell(g.code),
        cell(g.rate),
        cell(g.orders.size),
        cell(g.creditNotes.size),
        cell(rupees(g.taxable)),
        cell(rupees(g.cgst)),
        cell(rupees(g.sgst)),
        cell(rupees(g.igst)),
        cell(rupees(g.cgst + g.sgst + g.igst)),
      ].join(','),
    );
}

const csvFile = (res, name, columns, rows) => {
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  // The byte-order mark makes Excel read the file as UTF-8 (₹, names in other scripts).
  res.send(`\uFEFF${[columns.map((c) => cell(c)).join(','), ...rows].join('\r\n')}\r\n`);
};

// Admins download orders placed between two dates (both included) as a CSV for a spreadsheet, one row per order.
export function orderExportRouter({ db }) {
  const orders = db.collection('orders');
  const users = db.collection('users');
  const router = express.Router();
  router.use('/admin/orders/export', requireAdmin);

  // Mounted before the admin router, whose /admin/orders/:id would otherwise take "export" for an order id.
  router.get('/admin/orders/export', async (req, res) => {
    const query = parse(exportQuery, req.query);
    const from = istMidnight(query.from);
    const toStart = istMidnight(query.to);
    if (from === null || toStart === null) throw new HttpError(400, 'Choose a date');
    if (toStart < from) throw new HttpError(400, 'The end date must be on or after the start date');
    if ((toStart - from) / DAY + 1 > MAX_DAYS) throw new HttpError(400, `Choose at most ${MAX_DAYS} days`);

    const filter = { createdAt: { $gte: new Date(from), $lt: new Date(toStart + DAY) } };
    if (query.report === 'gst') {
      // Sales only, whatever the status choice; only orders placed with GST on have tax lines.
      const docs = await orders
        .find({ ...filter, status: { $in: SOLD }, gst: { $exists: true } })
        .limit(MAX_ROWS)
        .toArray();
      // Credit notes go by their own date: a return approved in these dates counts here even for an older order.
      const notes = await db
        .collection('returns')
        .find({ status: { $in: REFUNDED_RETURNS }, 'creditNote.date': filter.createdAt })
        .limit(MAX_ROWS)
        .toArray();
      const noteOrders = await orders.find({ _id: { $in: notes.map((r) => r.orderId) } }).toArray();
      const byId = new Map(noteOrders.map((o) => [o._id.toString(), o]));
      const credited = notes.map((ret) => ({ order: byId.get(ret.orderId.toString()), ret })).filter((c) => c.order);
      return csvFile(res, `gst-summary-${query.from}-to-${query.to}.csv`, GST_COLUMNS, gstSummaryRows(docs, credited));
    }
    if (query.status) filter.status = query.status;
    const docs = await orders.find(filter).sort({ createdAt: 1, _id: 1 }).limit(MAX_ROWS).toArray();
    const people = await users
      .find({ _id: { $in: [...new Set(docs.map((o) => o.userId))] } }, { projection: { name: 1, email: 1 } })
      .toArray();
    const byId = new Map(people.map((u) => [u._id.toString(), u]));
    // What returns of these orders refunded (approved ones and later, as on the dashboard).
    const refunds = new Map(
      (
        await db
          .collection('returns')
          .aggregate([
            { $match: { orderId: { $in: docs.map((o) => o._id) }, status: { $in: REFUNDED_RETURNS } } },
            { $group: { _id: '$orderId', refund: { $sum: '$refund' } } },
          ])
          .toArray()
      ).map((r) => [r._id.toString(), r.refund]),
    );

    const rows = docs.map((o) => {
      const customer = byId.get(o.userId.toString());
      // Orders from before online payments stored just 'cod'.
      const payment = typeof o.payment === 'string' ? { method: o.payment } : o.payment;
      const gst = gstInvoice(o);
      const tax = (key) => (gst ? rupees(gst.totals[key]) : '');
      return [
        cell(o.number ?? o._id.toString().slice(-8).toUpperCase()),
        cell(istDateTime(o.createdAt)),
        cell(o.returnedToSender ? 'returned to sender' : o.status),
        cell(customer?.name ?? o.address.name, { text: true }),
        cell(customer?.email ?? '', { text: true }),
        cell(o.items.reduce((n, i) => n + i.qty, 0)),
        cell(o.items.map((i) => `${i.title} × ${i.qty}`).join('; '), { text: true }),
        cell(rupees(o.subtotal)),
        cell(rupees(o.delivery)),
        cell(rupees(o.discount ?? 0)),
        cell(o.coupon?.code ?? '', { text: true }),
        cell(rupees(o.total)),
        cell(rupees(refunds.get(o._id.toString()) ?? 0)),
        cell(rupees(o.total - (refunds.get(o._id.toString()) ?? 0))),
        cell(gst ? gst.placeOfSupply.name : '', { text: true }),
        cell(tax('taxable')),
        cell(tax('cgst')),
        cell(tax('sgst')),
        cell(tax('igst')),
        cell(PAYMENT[payment.method] ?? 'Cash on Delivery'),
        cell(payment.status ?? ''),
        cell(rupees(o.creditUsed ?? 0)),
        cell(o.items.every((i) => i.cost != null) ? rupees(o.items.reduce((s, i) => s + i.cost * i.qty, 0)) : ''),
        cell(o.address.city, { text: true }),
        cell(o.address.state, { text: true }),
        cell(o.address.pincode, { text: true }),
        cell(o.shipment?.courier ?? '', { text: true }),
        cell(o.shipment?.trackingNumber ?? '', { text: true }),
      ].join(',');
    });

    const name = query.status
      ? `orders-${query.from}-to-${query.to}-${query.status}.csv`
      : `orders-${query.from}-to-${query.to}.csv`;
    csvFile(res, name, COLUMNS, rows);
  });

  return router;
}
