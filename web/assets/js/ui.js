// Shared UI helpers
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
export const inr = (n) => (n == null || isNaN(n) ? '—' : `₹${inrFmt.format(n)}`);
export const num = (n, d = 2) => (n == null || isNaN(n) ? '—' : new Intl.NumberFormat('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }).format(n));
export const int = (n) => (n == null || isNaN(n) ? '—' : new Intl.NumberFormat('en-IN').format(Math.round(n)));
export const pct = (n) => (n == null || isNaN(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
export const signed = (n) => (n == null || isNaN(n) ? '—' : `${n >= 0 ? '+' : ''}${inrFmt.format(n)}`);
export const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
export function compact(n) {
  if (n == null) return '—';
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return String(Math.round(n));
}
export const dt = (t) => new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const dateOnly = (t) => new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export function toast(msg, type = 'info', ms = 3500) {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.append(box); }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.setAttribute('role', 'status');
  t.innerHTML = esc(msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

export function modal(html, { wide = false, onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><button class="modal-x" aria-label="Close">×</button>${html}</div>`;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = (e) => e.key === 'Escape' && close();
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.classList.contains('modal-x')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  return { el: wrap.querySelector('.modal'), close };
}

export function confirmBox(text) {
  return new Promise((resolve) => {
    const m = modal(`<h3>Please confirm</h3><p>${esc(text)}</p><div class="row end"><button class="btn ghost" data-a="no">Cancel</button><button class="btn danger" data-a="yes">Confirm</button></div>`, { onClose: () => resolve(false) });
    m.el.addEventListener('click', (e) => { const a = e.target.dataset.a; if (a) { resolve(a === 'yes'); m.close(); } });
  });
}

export function sparkline(values, w = 120, h = 32) {
  if (!values?.length) return '';
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`).join(' ');
  const c = values.at(-1) >= values[0] ? 'var(--up)' : 'var(--down)';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline fill="none" stroke="${c}" stroke-width="1.6" points="${pts}"/></svg>`;
}

const PALETTE = ['#2E7DF6', '#12B886', '#F59F00', '#E8590C', '#7048E8', '#0CA678', '#D6336C', '#1098AD', '#74B816', '#868E96'];
export function donut(items, size = 160) {
  const total = items.reduce((a, x) => a + x.value, 0) || 1;
  let acc = 0;
  const r = size / 2 - 12, c = 2 * Math.PI * r;
  const segs = items.map((x, i) => {
    const len = (x.value / total) * c;
    const seg = `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="18" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-acc}"><title>${esc(x.label)} ${((x.value / total) * 100).toFixed(1)}%</title></circle>`;
    acc += len; return seg;
  }).join('');
  const legend = items.map((x, i) => `<li><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(x.label)} <b>${((x.value / total) * 100).toFixed(1)}%</b></li>`).join('');
  return `<div class="donut"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="transform:rotate(-90deg)">${segs}</svg><ul>${legend}</ul></div>`;
}

export function tabs(id, list, active) {
  return `<div class="tabs" role="tablist" data-tabs="${id}">${list.map(([k, label]) => `<button role="tab" class="tab ${k === active ? 'active' : ''}" data-tab="${k}" aria-selected="${k === active}">${label}</button>`).join('')}</div>`;
}

export function empty(text, cta = '') {
  return `<div class="empty"><svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><path d="M6 38 L18 24 L26 30 L42 12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><p>${text}</p>${cta}</div>`;
}

export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

export function downloadCSV(name, rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [keys.join(','), ...rows.map((r) => keys.map((k) => q(r[k])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const LOGO = `<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--brand)"/><path d="M7 21 L13 15 L17 18 L25 9" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="25" cy="9" r="2.2" fill="#fff"/><path d="M8 25h16" stroke="#fff" stroke-opacity=".45" stroke-width="2" stroke-linecap="round"/></svg>`;
