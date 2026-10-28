// Tags and notes about a customer (stage 82), shared by Admin → Customers (routes/customers.js) and the admin order
// page (routes/admin.js). Imports nothing: routes/customers.js leads to the dashboard, which imports routes/admin.js.

export const TAGS = { vip: 'VIP', wholesale: 'Wholesale', watch: 'Watch' };
export const MAX_NOTES = 50;
export const toAdminNote = (n) => ({ id: n._id.toString(), text: n.text, by: n.by?.name ?? null, at: n.at });
