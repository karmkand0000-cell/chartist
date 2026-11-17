// Chartist client app: shell, router, session, live data, watchlist, order window
import { CONFIG } from './config.js';
import { api, get, post, put, session, live, prefs } from './api.js';
import { $, $$, esc, num, pct, cls, toast, modal, LOGO, inr, debounce } from './ui.js';
import { displayName, isDerivative } from '../../shared/util.js';

import auth from './pages/auth.js';
import onboarding from './pages/onboarding.js';
import home from './pages/home.js';
import markets from './pages/markets.js';
import stock from './pages/stock.js';
import orders from './pages/orders.js';
import portfolio from './pages/portfolio.js';
import funds from './pages/funds.js';
import fno from './pages/fno.js';
import reports from './pages/reports.js';
import profile from './pages/profile.js';

const ROUTES = { '': home, login: auth, signup: auth, forgot: auth, onboarding, markets, stock, orders, portfolio, funds, fno, reports, profile };
const NAV = [
  ['', 'Dashboard', 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z'],
  ['markets', 'Markets', 'M3 17l6-6 4 4 8-8M14 7h7v7'],
  ['orders', 'Orders', 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5'],
  ['portfolio', 'Portfolio', 'M4 7h16v12H4zM9 7V5h6v2'],
  ['fno', 'Option Chain', 'M4 20V10M10 20V4M16 20v-7M22 20H2'],
  ['funds', 'Funds', 'M3 7h18v10H3zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4'],
  ['reports', 'Reports', 'M6 3h9l3 3v15H6zM9 12h6M9 16h6M9 8h3'],
  ['profile', 'Profile & security', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0'],
];

export const App = {
  user: null, meta: {}, funds: null, watchlists: [], page: null,
  go(p) { location.hash = `#/${p}`; },
  async refreshUser() { this.user = (await get('/api/me')).user; renderUserBox(); return this.user; },
  async refreshFunds() { if (this.user?.status === 'active') this.funds = await get('/api/funds').catch(() => null); return this.funds; },
  quote(token) { return live.quotes.get(token) || null; },
};

// ── Theme
const applyTheme = (t = prefs.get('theme', 'dark')) => { document.documentElement.dataset.theme = t; };
export function toggleTheme() { const t = prefs.get('theme', 'dark') === 'dark' ? 'light' : 'dark'; prefs.set('theme', t); applyTheme(t); window.dispatchEvent(new Event('themechange')); }

function shell() {
  document.body.innerHTML = `
  <header class="topbar">
    <button class="icon-btn only-mobile" id="menuBtn" aria-label="Menu"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    <a href="#/" class="logo">${LOGO}<span>${esc(CONFIG.brand)}</span></a>
    <div class="search" role="search"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input id="searchInput" type="search" placeholder="Search stocks, F&amp;O…  ( / )" autocomplete="off" aria-label="Search instruments"><div class="search-results" id="searchResults" hidden></div></div>
    <div class="ticker" id="ticker"></div>
    <div class="top-actions"><span class="mkt-status" id="mktStatus"></span>
      <button class="icon-btn" id="themeBtn" aria-label="Toggle theme"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" fill="currentColor"/></svg></button>
      <div id="userBox"></div></div>
  </header>
  <div class="layout">
    <nav class="sidebar" id="sidebar" aria-label="Main">${NAV.map(([k, l, d]) => `<a href="#/${k}" data-nav="${k}"><svg viewBox="0 0 24 24" width="20" height="20"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${l}</span></a>`).join('')}</nav>
    <main id="main" tabindex="-1"></main>
    <aside class="watch" id="watch" aria-label="Watchlist"></aside>
  </div>
  <nav class="bottomnav">${[NAV[0], NAV[1], NAV[2], NAV[3], NAV[4]].map(([k, l, d]) => `<a href="#/${k}" data-nav="${k}"><svg viewBox="0 0 24 24" width="22" height="22"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${l.split(' ')[0]}</span></a>`).join('')}</nav>
  <footer class="disclaimer" id="footer"></footer>`;
  $('#themeBtn').onclick = toggleTheme;
  $('#menuBtn').onclick = () => document.body.classList.toggle('nav-open');
  $('#sidebar').onclick = (e) => { if (e.target.closest('a')) document.body.classList.remove('nav-open'); };
  setupSearch();
  document.addEventListener('keydown', (e) => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#searchInput').focus(); } });
}

function setupSearch() {
  const input = $('#searchInput'), box = $('#searchResults');
  let items = [], sel = 0;
  const render = debounce(async () => {
    if (!input.value.trim()) { box.hidden = true; return; }
    items = await get(`/api/instruments/search?q=${encodeURIComponent(input.value)}`).catch(() => []);
    sel = 0; box.hidden = !items.length;
    box.innerHTML = items.map((q, i) => `<button class="sr ${i ? '' : 'sel'}" data-token="${esc(q.token)}"><b>${esc(q.symbol)}</b><span>${esc(q.segment === 'FO' ? 'NFO' : q.exchange)} · ${esc(q.name)}</span><em>${num(q.ltp)}</em></button>`).join('');
  }, 180);
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; $$('.sr', box).forEach((b, i) => b.classList.toggle('sel', i === sel)); }
    else if (e.key === 'Enter' && items[sel]) pick(items[sel].token); else if (e.key === 'Escape') { box.hidden = true; input.blur(); }
  });
  box.addEventListener('mousedown', (e) => { const b = e.target.closest('[data-token]'); if (b) pick(b.dataset.token); });
  input.addEventListener('blur', () => setTimeout(() => (box.hidden = true), 150));
  const pick = (t) => { box.hidden = true; input.value = ''; App.go(`stock/${encodeURIComponent(t)}`); };
}

function renderUserBox() {
  const box = $('#userBox');
  if (!App.user) { box.innerHTML = '<a class="btn ghost sm" href="#/login">Log in</a><a class="btn sm" href="#/signup">Open account</a>'; return; }
  const ini = App.user.name.split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase();
  box.innerHTML = `<button class="icon-btn" id="bellBtn" aria-label="Notifications"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
    <button class="avatar" id="avatarBtn" aria-label="Account">${esc(ini)}</button>
    <div class="menu" id="userMenu" hidden><div class="menu-head"><b>${esc(App.user.name)}</b><small>${esc(App.user.ucc || 'Account opening in progress')}</small></div>
      <a href="#/profile">Profile & security</a><a href="#/funds">Funds</a><a href="#/reports">Reports</a><button id="logoutBtn">Log out</button></div>`;
  $('#avatarBtn').onclick = (e) => { e.stopPropagation(); $('#userMenu').hidden = !$('#userMenu').hidden; };
  document.addEventListener('click', () => { const m = $('#userMenu'); if (m) m.hidden = true; });
  $('#logoutBtn').onclick = logout;
  $('#bellBtn').onclick = showNotifications;
}
export async function logout() { await post('/api/auth/logout').catch(() => {}); session.clear(); App.user = null; renderUserBox(); renderWatch(); App.go('login'); }

async function showNotifications() {
  const list = await get('/api/notifications').catch(() => []);
  modal(`<h3>Notifications</h3>${list.length ? `<ul class="events">${list.map((n) => `<li><b>${esc(n.title)}</b><br><small class="muted">${esc(n.body || '')} · ${new Date(n.created_at).toLocaleString('en-IN')}</small></li>`).join('')}</ul>` : '<p class="muted">No notifications yet.</p>'}`);
  post('/api/notifications/read').catch(() => {});
}

// ── Header ticker & market status
let indexTokens = [];
async function renderTicker() {
  const ov = await get('/api/market/overview').catch(() => null);
  if (!ov) return;
  indexTokens = ov.indices.map((q) => q.token);
  for (const q of [...ov.indices, ...ov.all]) live.quotes.set(q.token, { ...(live.quotes.get(q.token) || {}), ...q });
  live.sub(indexTokens);
  $('#ticker').innerHTML = ov.indices.map((q) => `<a class="tk" href="#/stock/${encodeURIComponent(q.token)}"><span>${esc(q.name)}</span><b data-ltp="${esc(q.token)}">${num(q.ltp)}</b><em class="${cls(q.change)}" data-chg="${esc(q.token)}">${pct(q.pct)}</em></a>`).join('');
  const m = App.meta = await get('/api/meta').catch(() => ({}));
  $('#mktStatus').innerHTML = `<span class="ws-dot ${live.connected ? 'on' : ''}" id="wsDot" title="Live feed"></span> ${m.market === 'OPEN' ? 'Market open' : m.market === 'PRE_OPEN' ? 'Pre-open' : 'Market closed'}${m.simulator ? ' <span class="pill-sim" title="Orders are matched by the exchange simulator">SIMULATOR</span>' : ''}`;
  $('#footer').innerHTML = `${esc(m.broker || '')} · SEBI Reg. ${esc(m.sebiReg || '')}${m.simulator ? ' · Simulator environment: orders are not sent to NSE/BSE.' : ''} Investments in securities market are subject to market risks; read all related documents carefully before investing.`;
}

function liveUpdate() {
  for (const el of $$('[data-ltp]')) {
    const q = live.quotes.get(el.dataset.ltp); if (!q?.ltp) continue;
    const txt = num(q.ltp);
    if (el.textContent !== txt) { const up = parseFloat(el.textContent.replace(/,/g, '')) < q.ltp; el.textContent = txt; el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth; el.classList.add(up ? 'flash-up' : 'flash-down'); }
  }
  for (const el of $$('[data-chg]')) {
    const q = live.quotes.get(el.dataset.chg); if (!q || q.pct == null) continue;
    el.textContent = el.dataset.mode === 'abs' ? `${q.change >= 0 ? '+' : ''}${num(q.change)} (${pct(q.pct)})` : pct(q.pct);
    el.className = `${el.className.replace(/\b(up|down|flat)\b/g, '').trim()} ${cls(q.change)}`;
  }
}

// ── Watchlist
let wlUnsub = null;
export async function loadWatchlists() { App.watchlists = await get('/api/watchlists').catch(() => []); renderWatch(); }
function renderWatch() {
  const w = $('#watch');
  if (!App.user) { w.innerHTML = `<div class="watch-cta"><h4>Start investing</h4><p>Open a free account in minutes — 100% online, paperless KYC.</p><a class="btn block" href="#/signup">Open account</a></div>`; return; }
  const lists = App.watchlists;
  if (!lists.length) { w.innerHTML = ''; return; }
  const idx = Math.min(prefs.get('wl', 0), lists.length - 1);
  const list = lists[idx];
  wlUnsub?.(); wlUnsub = live.sub(list.tokens);
  w.innerHTML = `<div class="wl-tabs">${lists.map((l, i) => `<button class="${i === idx ? 'active' : ''}" data-wl="${i}" title="${esc(l.name)}">${i + 1}</button>`).join('')}${lists.length < 7 ? '<button data-wl="new">+</button>' : ''}</div>
    <div class="wl-head"><b>${esc(list.name)}</b><span>${list.tokens.length}/100</span></div>
    <div class="wl-add"><input id="wlAdd" placeholder="Search & add…" aria-label="Add to watchlist" autocomplete="off"><div class="search-results" id="wlRes" hidden></div></div>
    <ul class="wl">${list.tokens.map((t) => { const q = live.quotes.get(t) || {}; return `<li data-token="${esc(t)}"><a href="#/stock/${encodeURIComponent(t)}"><b>${esc(displayName(t))}</b><small>${isDerivative(t) ? 'NFO' : t.startsWith('IDX') ? 'INDEX' : 'NSE'}</small></a>
      <div class="wl-px"><span data-ltp="${esc(t)}">${num(q.ltp)}</span><em class="${cls(q.change)}" data-chg="${esc(t)}">${pct(q.pct)}</em></div>
      <div class="wl-act">${t.startsWith('IDX') ? '' : '<button class="b" data-trade="BUY">B</button><button class="s" data-trade="SELL">S</button>'}<button class="x" data-rm>×</button></div></li>`; }).join('')}</ul>`;
  w.onclick = async (e) => {
    const t = e.target;
    if (t.dataset.wl === 'new') { await post('/api/watchlists', {}); prefs.set('wl', lists.length); return loadWatchlists(); }
    if (t.dataset.wl) { prefs.set('wl', +t.dataset.wl); return renderWatch(); }
    const li = t.closest('li[data-token]');
    if (li && t.dataset.trade) orderWindow(li.dataset.token, t.dataset.trade);
    if (li && t.hasAttribute('data-rm')) { list.tokens = list.tokens.filter((x) => x !== li.dataset.token); await put(`/api/watchlists/${list.id}`, { tokens: list.tokens }); renderWatch(); }
    const r = t.closest('[data-add]');
    if (r) { if (!list.tokens.includes(r.dataset.add)) { list.tokens.push(r.dataset.add); await put(`/api/watchlists/${list.id}`, { tokens: list.tokens }); } renderWatch(); }
  };
  const inp = $('#wlAdd'), res = $('#wlRes');
  inp.oninput = debounce(async () => {
    const items = inp.value.trim() ? await get(`/api/instruments/search?q=${encodeURIComponent(inp.value)}`).catch(() => []) : [];
    res.hidden = !items.length;
    res.innerHTML = items.slice(0, 8).map((q) => `<button class="sr" data-add="${esc(q.token)}"><b>${esc(q.symbol)}</b><span>${esc(q.name)}</span><em>${num(q.ltp)}</em></button>`).join('');
  }, 200);
}
export async function addToWatchlist(token) {
  if (!App.user) return App.go('login');
  const list = App.watchlists[Math.min(prefs.get('wl', 0), App.watchlists.length - 1)];
  if (list.tokens.includes(token)) return toast('Already in watchlist');
  list.tokens.push(token); await put(`/api/watchlists/${list.id}`, { tokens: list.tokens }); renderWatch(); toast(`Added to ${list.name}`, 'success');
}

// ── Order window (place / modify)
export async function orderWindow(token, side = 'BUY', preset = {}) {
  if (!App.user) return App.go(`login?next=${encodeURIComponent(location.hash.slice(2))}`);
  if (App.user.status !== 'active') { toast('Complete account opening to start trading', 'error'); return App.go('onboarding'); }
  const [inst, meta] = await Promise.all([get(`/api/instruments/${encodeURIComponent(token)}`), get('/api/meta').catch(() => App.meta)]);
  App.meta = meta;
  const fo = inst.segment === 'FO';
  const open = App.meta.market === 'OPEN';
  const q = inst.quote || {};
  const modifyId = preset.modifyId;
  const m = modal(`<div class="ticket ${side === 'BUY' ? 'buy' : 'sell'}">
    <div class="ticket-head"><div><h3>${esc(inst.symbol)}</h3><small>${fo ? `NFO · Lot ${inst.lot}` : 'NSE'} · LTP <b data-ltp="${esc(token)}">${num(q.ltp)}</b> <em class="${cls(q.change)}" data-chg="${esc(token)}">${pct(q.pct)}</em></small></div>
      ${modifyId ? `<span class="tag ${side === 'BUY' ? 'buy' : 'sell'}">${side} · Modify</span>` : `<div class="seg"><button type="button" data-side="BUY" class="${side === 'BUY' ? 'on' : ''}">Buy</button><button type="button" data-side="SELL" class="${side === 'SELL' ? 'on' : ''}">Sell</button></div>`}</div>
    <form id="tk">
      ${!open && !modifyId ? '<div class="banner info"><span>Market is closed. This will be placed as an <b>After Market Order (AMO)</b> and sent at 9:15 AM.</span></div>' : ''}
      <div class="seg wide">${(fo ? [['NRML', 'Overnight', 'NRML'], ['MIS', 'Intraday', 'MIS']] : [['CNC', 'Delivery', 'CNC'], ['MIS', 'Intraday', 'MIS · 5x']]).map(([v, l, s], i) => `<label><input type="radio" name="product" value="${v}" ${(preset.product || (fo ? 'NRML' : 'CNC')) === v ? 'checked' : ''} ${modifyId ? 'disabled' : ''}> ${l} <small>${s}</small></label>`).join('')}</div>
      <div class="grid3"><label>Qty${fo ? ` (lot ${inst.lot})` : ''}<input name="qty" type="number" min="${inst.lot}" step="${inst.lot}" value="${preset.qty || inst.lot}" required></label>
        <label>Price<input name="price" type="number" step="${inst.tick}" value="${preset.price ?? q.ltp ?? ''}"></label>
        <label>Trigger<input name="trigger_price" type="number" step="${inst.tick}" value="${preset.trigger_price ?? ''}"></label></div>
      <div class="seg wide">${['MARKET', 'LIMIT', 'SL', 'SL-M'].map((t) => `<label><input type="radio" name="order_type" value="${t}" ${(preset.order_type || 'MARKET') === t ? 'checked' : ''}> ${t}</label>`).join('')}</div>
      ${modifyId ? '' : '<label class="chip"><input type="checkbox" name="ioc"> IOC (immediate or cancel)</label>'}
      <div class="ticket-sum" id="tkSum"><span>Calculating margin…</span></div>
      <p class="form-err" id="tkErr"></p>
      <div class="row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn ${side === 'BUY' ? 'buy' : 'sell'}" id="tkGo">${modifyId ? 'Modify' : side === 'BUY' ? 'Buy' : 'Sell'}</button></div>
    </form></div>`);
  const f = m.el.querySelector('#tk');
  let cur = side;
  const unsub = live.sub([token]);
  const close = () => { unsub(); m.close(); };
  m.el.querySelector('[data-close]').onclick = close;
  const read = () => {
    const d = Object.fromEntries(new FormData(f));
    return { token, side: cur, qty: Number(d.qty), product: d.product || preset.product, order_type: d.order_type, price: d.price, trigger_price: d.trigger_price, validity: d.ioc ? 'IOC' : 'DAY', variety: open ? 'REGULAR' : 'AMO' };
  };
  const preview = debounce(async () => {
    const d = read();
    f.price.disabled = !['LIMIT', 'SL'].includes(d.order_type);
    f.trigger_price.disabled = !['SL', 'SL-M'].includes(d.order_type);
    if (modifyId) { $('#tkSum', m.el).innerHTML = '<span>Funds are re-checked on modify.</span>'; return; }
    const r = await post('/api/orders/margin', { ...d, price: f.price.disabled ? null : d.price, trigger_price: f.trigger_price.disabled ? null : d.trigger_price }).catch((e) => ({ error: e.message }));
    const c = r.charges || {};
    $('#tkSum', m.el).innerHTML = `<span>Required <b>${r.required != null ? inr(r.required) : '—'}</b></span><span>Available <b>${inr(r.funds?.available)}</b></span><span title="Brokerage ${c.brokerage} · STT ${c.stt} · Exchange ${c.exchange} · GST ${c.gst} · Stamp ${c.stamp} · SEBI ${c.sebi}${c.dp ? ' · DP ' + c.dp : ''}">Charges <b>${inr(c.total)}</b> ⓘ</span><span>Order value <b>${inr(d.qty * (Number(f.price.disabled ? q.ltp : d.price) || 0))}</b></span>`;
    $('#tkErr', m.el).textContent = r.error || '';
  }, 250);
  m.el.querySelectorAll('[data-side]').forEach((b) => (b.onclick = () => {
    cur = b.dataset.side;
    m.el.querySelectorAll('[data-side]').forEach((x) => x.classList.toggle('on', x === b));
    m.el.querySelector('.ticket').className = `ticket ${cur === 'BUY' ? 'buy' : 'sell'}`;
    const go = $('#tkGo', m.el); go.className = `btn ${cur === 'BUY' ? 'buy' : 'sell'}`; go.textContent = cur === 'BUY' ? 'Buy' : 'Sell';
    preview();
  }));
  f.addEventListener('input', preview);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = read();
    if (f.price.disabled) d.price = null;
    if (f.trigger_price.disabled) d.trigger_price = null;
    const btn = $('#tkGo', m.el); btn.disabled = true;
    try {
      const o = modifyId ? await api(`/api/orders/${modifyId}`, { method: 'PATCH', body: d }) : await post('/api/orders', { ...d, client_order_id: crypto.randomUUID?.() || String(Date.now()) });
      toast(modifyId ? 'Modify request sent' : `${o.side} order placed: ${o.qty} ${o.name} (${o.status.replace(/_/g, ' ').toLowerCase()})`, 'success');
      close();
    } catch (err) { $('#tkErr', m.el).textContent = err.message; btn.disabled = false; }
  });
  preview();
}

// ── Router
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [p, qs = ''] = raw.split('?');
  const parts = p.split('/').map(decodeURIComponent);
  return { name: parts[0] || '', params: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs)) };
}
let current = null;
export async function rerender() {
  const r = parseHash();
  const page = ROUTES[r.name];
  // Fresh <main> per page so event handlers from the previous page never leak
  const old = $('#main'), main = old.cloneNode(false);
  old.replaceWith(main);
  current?.unmount?.();
  if (!page) { main.innerHTML = '<section class="page"><h1>Page not found</h1></section>'; return; }
  if (page.auth && !App.user) return App.go(`login?next=${encodeURIComponent(location.hash.slice(2))}`);
  if (page.active && App.user && App.user.status !== 'active') {
    await App.refreshUser().catch(() => {});
    if (App.user?.status !== 'active') return App.go('onboarding');
    await loadWatchlists(); await App.refreshFunds();
  }
  current = page;
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === r.name));
  document.title = `${page.title ? (typeof page.title === 'function' ? page.title(r) : page.title) + ' · ' : ''}${CONFIG.brand}`;
  main.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try { main.innerHTML = await page.render(r); await page.mount?.(main, r); }
  catch (e) {
    if (e.status === 401) { session.clear(); App.user = null; renderUserBox(); return App.go('login'); }
    console.error(e); main.innerHTML = `<section class="page"><h1>Something went wrong</h1><p class="err">${esc(e.message)}</p></section>`;
  }
}
export async function onLogin(tokens) {
  session.save(tokens); App.user = tokens.user; live.reauth();
  renderUserBox(); await loadWatchlists(); await App.refreshFunds();
}

async function boot() {
  applyTheme(); shell();
  live.connect();
  live.on((m) => {
    if (m.t === 'q') { liveUpdate(); current?.onTick?.(); }
    if (m.t === 'status') { const d = $('#wsDot'); if (d) d.classList.toggle('on', m.connected); }
    if (m.t === 'order') { const o = m.d; if (['COMPLETE', 'REJECTED', 'CANCELLED'].includes(o.status) && o.name) toast(`${o.status === 'COMPLETE' ? '✅ Executed' : o.status === 'REJECTED' ? '⛔ Rejected' : 'Cancelled'}: ${o.side} ${o.qty} ${o.name}${o.status === 'COMPLETE' ? ` @ ${num(o.avg_price)}` : o.status_message ? ` — ${o.status_message}` : ''}`, o.status === 'REJECTED' ? 'error' : 'success', 5000); current?.onOrder?.(o); App.refreshFunds(); }
    if (m.t === 'notify') toast(`${m.d.title}${m.d.body ? ': ' + m.d.body : ''}`, 'info', 7000);
  });
  if (session.refresh) { try { await App.refreshUser(); await loadWatchlists(); await App.refreshFunds(); } catch { session.clear(); App.user = null; } }
  renderUserBox(); renderWatch();
  await renderTicker();
  setInterval(renderTicker, 60000);
  window.addEventListener('hashchange', rerender);
  await rerender();
}
boot();
export { renderWatch };
