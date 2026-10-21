import { useSyncExternalStore } from 'react';

// The cart lives in localStorage as [{ productId, qty }], for guests and logged-in users alike.
// Prices and stock are never stored here: the cart page and checkout ask the server (GET /api/cart).
const KEY = 'bazaar.cart';
export const MAX_QTY = 10;
export const MAX_CART_ITEMS = 20;

const valid = (i) => /^[0-9a-f]{24}$/.test(i?.productId) && Number.isInteger(i.qty) && i.qty >= 1 && i.qty <= MAX_QTY;

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
export const cartQuery = (list) => list.map((i) => `${i.productId}:${i.qty}`).join(',');

// Returns false when the cart already holds the maximum number of different products.
export function addToCart(productId, stock) {
  const limit = Math.min(MAX_QTY, stock);
  const existing = items.find((i) => i.productId === productId);
  if (existing) {
    setQty(productId, Math.min(existing.qty + 1, limit));
    return true;
  }
  if (items.length >= MAX_CART_ITEMS) return false;
  update([...items, { productId, qty: 1 }]);
  return true;
}

export function setQty(productId, qty) {
  update(items.map((i) => (i.productId === productId ? { ...i, qty } : i)));
}

export function removeFromCart(productId) {
  update(items.filter((i) => i.productId !== productId));
}

export function clearCart() {
  update([]);
}
