import { useSyncExternalStore } from 'react';

// The cart lives in localStorage as [{ productId, variantId?, qty }], for guests and logged-in users alike; variantId
// is the chosen size/colour of a product that has them.
// Prices and stock are never stored here: the cart page and checkout ask the server (GET /api/cart).
const KEY = 'bazaar.cart';
// Whose copy this browser's cart is, and whether it has changes the account doesn't have yet (see cartSync.jsx).
const OWNER_KEY = 'bazaar.cartOwner';
const UNSAVED_KEY = 'bazaar.cartUnsaved';
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

// `saved`: the change comes from the account's saved cart (cartSync.jsx), so there's nothing new to save.
function update(next, { saved = false } = {}) {
  items = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    // A customer's own change to an account's cart is marked until the account has it, so a page load in between
    // keeps it rather than taking the older saved cart.
    if (!saved && localStorage.getItem(OWNER_KEY)) localStorage.setItem(UNSAVED_KEY, '1');
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

// The cart as it is now, outside React (cartSync.jsx).
export const currentCart = () => items;

// Replaces the whole cart with the account's saved one, keeping only valid lines.
export function replaceCart(list) {
  update(list.filter(valid).slice(0, MAX_CART_ITEMS), { saved: true });
}

// Which account this browser's cart belongs to (its id), or null for a guest's cart. A guest's cart is merged into the
// account's on login; an account's own copy is simply replaced by the saved one (cartSync.jsx).
export function cartOwner() {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}
export function setCartOwner(userId) {
  try {
    if (userId) localStorage.setItem(OWNER_KEY, userId);
    else localStorage.removeItem(OWNER_KEY);
  } catch {
    // Storage blocked: the cart isn't kept between visits anyway.
  }
}

// Whether this browser's cart has changes the account doesn't have yet; `markCartSaved` once it has them.
export function cartUnsaved() {
  try {
    return localStorage.getItem(UNSAVED_KEY) === '1';
  } catch {
    return false;
  }
}
export function markCartSaved() {
  try {
    localStorage.removeItem(UNSAVED_KEY);
  } catch {
    // Storage blocked: nothing was marked.
  }
}

// Logging out: the cart stays saved in the account, not in this browser.
export function forgetCart() {
  setCartOwner(null);
  markCartSaved();
  update([]);
}
