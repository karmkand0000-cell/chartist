// REST + WebSocket client with token refresh and live quote subscriptions
import { CONFIG } from './config.js';

const NS = window.CHARTIST_NS || 'chb';
const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(`${NS}_${k}`)); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(`${NS}_${k}`) : localStorage.setItem(`${NS}_${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};
export const session = {
  get access() { return store.get('access'); }, get refresh() { return store.get('refresh'); },
  save({ accessToken, refreshToken }) { store.set('access', accessToken); store.set('refresh', refreshToken); },
  clear() { store.set('access', null); store.set('refresh', null); },
};
export const prefs = { get: (k, d) => store.get(`p_${k}`) ?? d, set: (k, v) => store.set(`p_${k}`, v) };

export class ApiError extends Error { constructor(msg, status, body) { super(msg); this.status = status; this.body = body; } }
let refreshing = null;
async function doRefresh() {
  if (!session.refresh) throw new ApiError('Not logged in', 401);
  refreshing ||= fetch(`${CONFIG.API_BASE}/api/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: session.refresh }) })
    .then(async (r) => { const b = await r.json(); if (!r.ok) { session.clear(); throw new ApiError(b.error || 'Session expired', r.status); } session.save(b); live.reauth(); return b; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api(path, { method = 'GET', body, raw = false, auth = true } = {}) {
  const go = () => fetch(`${CONFIG.API_BASE}${path}`, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth && session.access ? { Authorization: `Bearer ${session.access}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let r = await go();
  if (r.status === 401 && auth && session.refresh && !path.startsWith('/api/auth/')) { await doRefresh(); r = await go(); }
  if (raw) { if (!r.ok) throw new ApiError('Request failed', r.status); return r; }
  const b = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new ApiError(b?.error || `Request failed (${r.status})`, r.status, b);
  return b;
}
export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body: body || {} });
export const put = (p, body) => api(p, { method: 'PUT', body: body || {} });
export const patch = (p, body) => api(p, { method: 'PATCH', body: body || {} });
export const del = (p) => api(p, { method: 'DELETE' });

// ── Live feed
export const live = {
  quotes: new Map(), subs: new Map(), handlers: new Set(), ws: null, connected: false, retry: 0,
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); },
  emit(m) { for (const fn of this.handlers) { try { fn(m); } catch (e) { console.error(e); } } },
  sub(tokens) {
    const add = [];
    for (const t of tokens) { this.subs.set(t, (this.subs.get(t) || 0) + 1); if (this.subs.get(t) === 1) add.push(t); }
    if (add.length && this.connected) this.ws.send(JSON.stringify({ op: 'sub', tokens: add }));
    return () => { for (const t of tokens) { const n = (this.subs.get(t) || 1) - 1; if (n <= 0) this.subs.delete(t); else this.subs.set(t, n); } };
  },
  connect() {
    const base = CONFIG.API_BASE || location.origin;
    const url = base.replace(/^http/, 'ws') + '/ws';
    try { this.ws = new WebSocket(url); } catch { return this.later(); }
    this.ws.onopen = () => {
      this.connected = true; this.retry = 0;
      if (session.access) this.ws.send(JSON.stringify({ op: 'auth', token: session.access }));
      if (this.subs.size) this.ws.send(JSON.stringify({ op: 'sub', tokens: [...this.subs.keys()] }));
      this.emit({ t: 'status', connected: true });
    };
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'q') for (const [k, v] of Object.entries(m.d)) this.quotes.set(k, { ...(this.quotes.get(k) || {}), ...v });
      this.emit(m);
    };
    this.ws.onclose = () => { this.connected = false; this.emit({ t: 'status', connected: false }); this.later(); };
    this.ws.onerror = () => this.ws.close();
  },
  later() { setTimeout(() => this.connect(), Math.min(15000, 1000 * 2 ** this.retry++)); },
  reauth() { if (this.connected && session.access) this.ws.send(JSON.stringify({ op: 'auth', token: session.access })); },
};
