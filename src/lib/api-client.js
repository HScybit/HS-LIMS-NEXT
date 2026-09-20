export async function apiRequest(path, { method = 'GET', body, signal } = {}) {
  const csrfToken = document.cookie.split('; ').find((item) => item.startsWith('sampleify_csrf='))?.slice('sampleify_csrf='.length) ?? '';
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message ?? 'The request failed.');
    error.code = result.error?.code;
    error.status = response.status;
    throw error;
  }
  return result;
}

export async function apiBlobRequest(path, { method = 'POST', body, signal } = {}) {
  const csrfToken = document.cookie.split('; ').find((item) => item.startsWith('sampleify_csrf='))?.slice('sampleify_csrf='.length) ?? '';
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const error = new Error(result.error?.message ?? 'The request failed.');
    error.code = result.error?.code;
    error.status = response.status;
    throw error;
  }
  return response.blob();
}

export function notifySessionChange() {
  if ('BroadcastChannel' in window) {
    const channel = new BroadcastChannel('sampleify_session');
    channel.postMessage('changed');
    channel.close();
  }
}
