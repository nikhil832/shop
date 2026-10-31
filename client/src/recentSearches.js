import { useSyncExternalStore } from 'react';

// Recent searches (stage 115): what this browser searched for lately, newest first, shown by the header's search box
// while it's empty. Kept only in localStorage, never sent anywhere.
const KEY = 'bazaar.searches';
export const MAX_SEARCHES = 6;
const MAX_LENGTH = 100;

// Single spaces, and one entry per search whatever its case ("Phone" replaces "phone").
const tidy = (term) => term.trim().replace(/\s+/g, ' ').slice(0, MAX_LENGTH);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(saved)
      ? saved
          .filter((s) => typeof s === 'string' && tidy(s))
          .map(tidy)
          .slice(0, MAX_SEARCHES)
      : [];
  } catch {
    return [];
  }
}

let terms = load();
const listeners = new Set();

function update(next) {
  terms = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked (private mode etc.): remembered until the page reloads.
  }
  listeners.forEach((l) => l());
}

window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  terms = load();
  listeners.forEach((l) => l());
});

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useRecentSearches = () => useSyncExternalStore(subscribe, () => terms);

export function rememberSearch(term) {
  const t = tidy(term);
  if (!t || terms[0] === t) return;
  update([t, ...terms.filter((s) => !same(s, t))].slice(0, MAX_SEARCHES));
}

export const clearSearches = () => update([]);
