export async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 204) return null;
  // A body that isn't JSON reads as {} (the status says what happened), but a request cancelled while its body was
  // arriving stays an AbortError: as {} it would pass for an empty answer (useFetch showed it in place of the data).
  const data = await res.json().catch((err) => {
    if (signal?.aborted) throw err;
    return {};
  });
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
