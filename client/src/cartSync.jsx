import { useEffect, useRef } from 'react';
import { request } from './api.js';
import { useAuth } from './auth.jsx';
import {
  cartOwner,
  cartUnsaved,
  currentCart,
  lineKey,
  markCartSaved,
  MAX_CART_ITEMS,
  replaceCart,
  setCartOwner,
  useCart,
} from './cart.js';

// Keeps a logged-in customer's cart saved in their account (PUT /api/cart/saved), so it follows them between devices:
// - on login (or opening the store logged in): a guest's cart in this browser is merged into the saved one (the larger
//   quantity of a line in both); this account's own copy is replaced by the saved one, so what was removed on another
//   device stays removed, unless it has changes not saved yet (cart.js marks them, so they survive a page load, e.g.
//   "Add to cart" then straight to checkout): then it's the newest and is saved;
// - every change here is saved, shortly after;
// - coming back to the tab loads the saved cart again (unless a change here is still waiting to be saved).
// Logging out empties this browser's cart (forgetCart in Orders.jsx); an expired session doesn't, so nothing unsaved
// is lost. Renders nothing.

const key = (list) => JSON.stringify(list.map((i) => [lineKey(i), i.qty]).sort());

export function mergeCarts(saved, local) {
  const byKey = new Map(saved.map((i) => [lineKey(i), i]));
  for (const i of local) {
    const mine = byKey.get(lineKey(i));
    byKey.set(lineKey(i), mine ? { ...mine, qty: Math.max(mine.qty, i.qty) } : i);
  }
  return [...byKey.values()].slice(0, MAX_CART_ITEMS);
}

export default function CartSync() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const items = useCart();
  // The cart as last saved or loaded, so only real changes are sent; null until the first load after login.
  const saved = useRef(null);
  const pending = useRef(null); // the timer of a save waiting to go

  // On login: load the saved cart, then merge or replace.
  useEffect(() => {
    saved.current = null;
    if (!userId) return;
    let stale = false;
    request('/cart/saved')
      .then(async ({ items: stored }) => {
        if (stale) return;
        const local = currentCart();
        const next = cartOwner() === null ? mergeCarts(stored, local) : cartUnsaved() ? local : stored;
        setCartOwner(userId);
        replaceCart(next);
        saved.current = key(stored);
        if (key(next) !== key(stored)) {
          await request('/cart/saved', { method: 'PUT', body: { items: next } });
          saved.current = key(next);
        }
        if (key(currentCart()) === saved.current) markCartSaved();
      })
      .catch(() => {}); // offline or logged out meanwhile: the cart stays as it is here
    return () => {
      stale = true;
    };
  }, [userId]);

  // Each change, once the first load is done: saved after a short pause (several clicks become one save).
  useEffect(() => {
    if (!userId || saved.current === null || key(items) === saved.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      const list = currentCart();
      request('/cart/saved', { method: 'PUT', body: { items: list } })
        .then(() => {
          saved.current = key(list);
          if (key(currentCart()) === saved.current) markCartSaved(); // nothing newer since
        })
        .catch(() => {});
    }, 400);
    return () => {
      clearTimeout(pending.current);
      pending.current = null;
    };
  }, [items, userId]);

  // Back to this tab: another device may have changed the cart.
  useEffect(() => {
    if (!userId) return;
    async function refresh() {
      if (document.visibilityState !== 'visible' || saved.current === null || cartUnsaved()) return;
      try {
        const { items: stored } = await request('/cart/saved');
        if (cartUnsaved()) return; // changed here meanwhile: that wins
        saved.current = key(stored);
        if (key(stored) !== key(currentCart())) replaceCart(stored);
      } catch {
        // Offline: try again next time.
      }
    }
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [userId]);

  return null;
}
