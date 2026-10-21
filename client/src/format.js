const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

// Prices are integers in paise.
export const formatPrice = (paise) => inr.format(paise / 100);

export const discountPercent = (price, mrp) => (mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0);

const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
export const formatDate = (iso) => dateFormat.format(new Date(iso));

// A short, readable order number derived from the order's id.
export const orderNumber = (id) => id.slice(-8).toUpperCase();

export const ORDER_STATUS = { placed: 'Placed', cancelled: 'Cancelled' };
