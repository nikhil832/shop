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

// Uploads a file as the raw request body (POST /api/admin/images); returns { id, url }.
export async function upload(path, file) {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}
