import { useEffect, useState } from 'react';
import { request } from './api.js';

// Loads `path` (or nothing when null), cancelling stale requests when it changes.
// `loading` is derived: true until the result for the current path has arrived.
export function useFetch(path, version = 0) {
  const [result, setResult] = useState({ key: null, data: null, error: null });
  const key = path && `${version}:${path}`;

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    request(path, { signal: controller.signal })
      .then((data) => setResult({ key, data, error: null }))
      .catch((error) => {
        if (error.name !== 'AbortError') setResult({ key, data: null, error });
      });
    return () => controller.abort();
  }, [key, path]);

  const current = result.key === key;
  return {
    // Keep showing the previous data while the next request loads, to avoid flashing.
    data: result.data,
    error: current ? result.error : null,
    loading: Boolean(key) && !current,
  };
}
