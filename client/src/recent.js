import { useSyncExternalStore } from 'react';

// Products this browser viewed lately, in localStorage as slugs, newest first. Only addresses are kept: cards (price,
// stock) come from the server (GET /api/recently-viewed), which leaves out products hidden since.
const KEY = 'bazaar.recent';
export const MAX_RECENT = 10;
const SLUG = /^[a-z0-9-]{1,160}$/;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(saved) ? saved.filter((s) => SLUG.test(s)).slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

let slugs = load();
const listeners = new Set();

function update(next) {
  slugs = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked (private mode etc.): remembered until the page reloads.
  }
  listeners.forEach((l) => l());
}

window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  slugs = load();
  listeners.forEach((l) => l());
});

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useRecentlyViewed = () => useSyncExternalStore(subscribe, () => slugs);

export function rememberViewed(slug) {
  if (slugs[0] === slug) return;
  update([slug, ...slugs.filter((s) => s !== slug)].slice(0, MAX_RECENT));
}

export const clearRecentlyViewed = () => update([]);
