import { useSyncExternalStore } from 'react';

// The cart lives in localStorage as [{ productId, variantId?, qty }], for guests and logged-in users alike; variantId
// is the chosen size/colour of a product that has them.
// Prices and stock are never stored here: the cart page and checkout ask the server (GET /api/cart).
const KEY = 'bazaar.cart';
export const MAX_QTY = 10;
export const MAX_CART_ITEMS = 20;

const HEX_ID = /^[0-9a-f]{24}$/;
const valid = (i) =>
  HEX_ID.test(i?.productId) &&
  (i.variantId === undefined || HEX_ID.test(i.variantId)) &&
  Number.isInteger(i.qty) &&
  i.qty >= 1 &&
  i.qty <= MAX_QTY;

// One line per product, or per variant of a product: works on cart items and on the server's quote lines alike.
export const lineKey = (i) => (i.variantId ? `${i.productId}.${i.variantId}` : i.productId);

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(saved) ? saved.filter(valid).slice(0, MAX_CART_ITEMS) : [];
  } catch {
    return [];
  }
}

let items = load();
const listeners = new Set();

function update(next) {
  items = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked (private mode etc.): the cart still works until the page reloads.
  }
  listeners.forEach((l) => l());
}

// Keep tabs in sync.
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  items = load();
  listeners.forEach((l) => l());
});

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useCart = () => useSyncExternalStore(subscribe, () => items);

export const cartCount = (list) => list.reduce((n, i) => n + i.qty, 0);
export const cartQuery = (list) => list.map((i) => `${lineKey(i)}:${i.qty}`).join(',');

// How many of this product (and variant) are in the cart.
export const qtyInCart = (list, productId, variantId) =>
  list.find((i) => lineKey(i) === lineKey({ productId, variantId }))?.qty ?? 0;

// Adds one; `stock` is the product's, or the variant's. Returns false when the cart already holds the maximum number
// of different lines.
export function addToCart(productId, stock, variantId) {
  const key = lineKey({ productId, variantId });
  const limit = Math.min(MAX_QTY, stock);
  const existing = items.find((i) => lineKey(i) === key);
  if (existing) {
    setQty(key, Math.min(existing.qty + 1, limit));
    return true;
  }
  if (items.length >= MAX_CART_ITEMS) return false;
  update([...items, { productId, ...(variantId && { variantId }), qty: 1 }]);
  return true;
}

export function setQty(key, qty) {
  update(items.map((i) => (lineKey(i) === key ? { ...i, qty } : i)));
}

export function removeFromCart(key) {
  update(items.filter((i) => lineKey(i) !== key));
}

export function clearCart() {
  update([]);
}
