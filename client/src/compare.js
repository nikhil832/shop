import { useSyncExternalStore } from 'react';

// Products chosen for comparing (stage 73), in localStorage as [{ slug, title, categoryId }], at most MAX_COMPARE, all
// from one category: choosing one from another category starts a new comparison (`startedOver` says so, until the next
// change). Details come from the server (GET /api/compare), so prices and stock are live.
const KEY = 'bazaar.compare';
export const MAX_COMPARE = 3;
const SLUG = /^[a-z0-9-]{1,160}$/;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    const items = Array.isArray(saved)
      ? saved
          .filter((p) => SLUG.test(p?.slug) && typeof p.title === 'string' && typeof p.categoryId === 'string')
          .slice(0, MAX_COMPARE)
      : [];
    return { items, startedOver: false };
  } catch {
    return { items: [], startedOver: false };
  }
}

let state = load();
const listeners = new Set();

function update(items, startedOver = false) {
  state = { items, startedOver };
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Storage blocked: remembered until the page reloads.
  }
  listeners.forEach((l) => l());
}

window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  state = load();
  listeners.forEach((l) => l());
});

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useCompare = () => useSyncExternalStore(subscribe, () => state);

// Adds `product` (a card: slug, title, categoryId) or takes it out.
export function toggleCompare(product) {
  const { items } = state;
  if (items.some((p) => p.slug === product.slug)) return update(items.filter((p) => p.slug !== product.slug));
  const entry = { slug: product.slug, title: product.title, categoryId: product.categoryId };
  if (items.length && items[0].categoryId !== product.categoryId) return update([entry], true);
  if (items.length >= MAX_COMPARE) return;
  update([...items, entry]);
}

export const removeFromCompare = (slug) => update(state.items.filter((p) => p.slug !== slug));
export const clearCompare = () => update([]);
export const compareLink = (items) => `/compare?slugs=${items.map((p) => p.slug).join(',')}`;
