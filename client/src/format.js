const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

// Prices are integers in paise.
export const formatPrice = (paise) => inr.format(paise / 100);

export const discountPercent = (price, mrp) => (mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0);

const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
export const formatDate = (iso) => dateFormat.format(new Date(iso));

// The order's sequential number; orders from before numbering show the end of their id instead.
export const orderNumber = (order) => String(order.number ?? order.id.slice(-8).toUpperCase());

export const ORDER_STATUS = { placed: 'Placed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };

// Prices are typed in rupees (decimals allowed) and stored in paise.
export const toPaise = (rupees) => Math.round(Number(rupees) * 100);
export const toRupees = (paise) => String(paise / 100);
