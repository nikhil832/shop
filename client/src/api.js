export async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Builds a query string from defined, non-empty values.
export const query = (params) => {
  const defined = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return defined.length ? `?${new URLSearchParams(defined)}` : '';
};
