/** Thin client for the hub's REST API + live event stream. */

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(method, path, body, { timeout = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch (err) {
    throw new ApiError(err.name === 'AbortError' ? 'The hub took too long to answer.' : "Can't reach the Airwave hub. Is it running?", 0, 'network');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new ApiError(data?.error?.message || `Request failed (${res.status})`, res.status, data?.error?.code);
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);

/**
 * Keep an EventSource open, reconnecting after network changes and when the
 * app returns to the foreground (iOS suspends background tabs).
 */
export function connectEvents({ onState, onSpeaker, onStatus }) {
  let es = null;
  let retry = null;
  let lastMessage = 0;

  function open() {
    clearTimeout(retry);
    if (es) es.close();
    es = new EventSource('/api/events');
    es.addEventListener('open', () => {
      lastMessage = Date.now();
      onStatus(true);
    });
    es.addEventListener('state', (e) => {
      lastMessage = Date.now();
      onStatus(true);
      onState(JSON.parse(e.data));
    });
    es.addEventListener('speaker', (e) => {
      lastMessage = Date.now();
      onSpeaker(JSON.parse(e.data));
    });
    es.addEventListener('error', () => {
      onStatus(false);
      if (es.readyState === EventSource.CLOSED) retry = setTimeout(open, 2500);
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!es || es.readyState !== EventSource.OPEN || Date.now() - lastMessage > 45000)) open();
  });
  window.addEventListener('online', open);
  // Server pings every 20 s; if we hear nothing for 50 s, reconnect.
  setInterval(() => {
    if (document.visibilityState === 'visible' && lastMessage && Date.now() - lastMessage > 50000) open();
  }, 10000);
  open();
}
