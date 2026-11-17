// Chartist back-office console (admin / RMS / operations / support)
import { api, get, post, put, session } from '../assets/js/api.js';
import { CONFIG } from '../assets/js/config.js';
import { $, $$, esc, inr, num, dt, toast, modal, confirmBox, tabs, empty, signed, cls, downloadCSV, LOGO } from '../assets/js/ui.js';

let me = null, view = 'dashboard', sub = '';
const NAV = [['dashboard', 'Dashboard'], ['kyc', 'KYC queue'], ['clients', 'Clients'], ['funds', 'Fund requests'], ['orders', 'Orders & trades'], ['rms', 'Risk (RMS)'], ['ipo', 'IPO & MF'], ['ops', 'Operations'], ['audit', 'Audit log']];

function shell() {
  document.body.innerHTML = `<header class="topbar"><a class="logo" href="#">${LOGO}<span>${esc(CONFIG.brand)} Back Office</span></a><div class="ticker"></div><div class="top-actions"><span class="mkt-status" id="ms"></span><span class="muted small">${esc(me.name)} · ${esc(me.role)}</span><button class="btn ghost sm" id="lo">Log out</button></div></header>
  <div class="layout" style="grid-template-columns:220px minmax(0,1fr)"><nav class="sidebar">${NAV.map(([k, l]) => `<a href="#${k}" data-nav="${k}"><span>${l}</span></a>`).join('')}</nav><main id="main"></main></div>`;
  $('#lo').onclick = async () => { await post('/api/auth/logout').catch(() => {}); session.clear(); location.reload(); };
}

async function loginScreen(err = '') {
  document.body.innerHTML = `<section class="auth"><div class="card auth-card"><a class="logo center">${LOGO}<span>Back Office</span></a><h1>Staff login</h1>
    <form id="f"><label>Email<input name="login" required autocomplete="username"></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label><p class="form-err" id="e">${esc(err)}</p><button class="btn block lg">Continue</button></form></div></section>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const l = await post('/api/auth/login', Object.fromEntries(new FormData(e.target)));
      if (l.accessToken) return done(l);
      document.querySelector('.auth-card').innerHTML = `<h1>Verify</h1><p class="muted">${l.mfa === 'TOTP' ? 'Authenticator code' : `OTP sent to ${esc(l.sentTo)}`}</p><form id="m"><input name="code" class="otp" maxlength="6" required autofocus>${l.devOtp ? `<p class="note">Dev OTP: <b>${esc(l.devOtp)}</b></p>` : ''}<p class="form-err" id="e2"></p><button class="btn block lg">Verify</button></form>`;
      $('#m').onsubmit = async (ev) => { ev.preventDefault(); try { done(await post('/api/auth/mfa', { ticket: l.ticket, code: ev.target.code.value })); } catch (x) { $('#e2').textContent = x.message; } };
    } catch (x) { $('#e').textContent = x.message; }
  };
  const done = (s) => { if (s.user.role === 'client') { session.clear(); return loginScreen('This console is for broker staff only.'); } session.save(s); location.reload(); };
}

const st = (s) => `<span class="st ${({ approved: 'COMPLETE', active: 'COMPLETE', pending: 'OPEN', submitted: 'OPEN', kyc_submitted: 'OPEN', rejected: 'REJECTED', suspended: 'REJECTED' })[s] || s}">${esc(String(s).replace(/_/g, ' '))}</span>`;

const VIEWS = {
  async dashboard() {
    const d = await get('/api/admin/dashboard');
    const users = Object.fromEntries(d.users.map((u) => [u.status, u.n]));
    return `<div class="page-head"><h1>Dashboard</h1><span>${st(d.market)} <span class="pill-sim">${esc(d.exchange)}</span>${d.settings.kill_switch ? ' <span class="badge warn">KILL SWITCH ON</span>' : ''}</span></div>
      <div class="stats">${[['Active clients', users.active || 0], ['Onboarding', (users.onboarding || 0) + (users.kyc_submitted || 0)], ['KYC to review', d.kycPending], ['Fund requests', d.fundPending], ['Client funds', inr(d.clientCash)], ["Today's turnover", inr(d.today.turnover)], ['Trades today', d.today.trades], ['Open positions', d.openPositions]].map(([k, v]) => `<div class="card stat"><small>${k}</small><b>${v}</b></div>`).join('')}</div>
      <div class="grid2"><div class="card"><h3>Orders today</h3>${d.ordersToday.length ? `<table class="tbl">${d.ordersToday.map((o) => `<tr><td>${st(o.status)}</td><td class="r">${o.n}</td></tr>`).join('')}</table>` : empty('No orders today.')}</div>
      <div class="card"><h3>Recent risk events</h3>${d.riskEvents.length ? `<ul class="events">${d.riskEvents.map((r) => `<li><b>${esc(r.kind)}</b> · ${esc(r.ucc || '')} ${esc(r.message)} <small class="muted">${dt(r.created_at)}</small></li>`).join('')}</ul>` : empty('No risk events.')}</div></div>
      <div class="card"><h3>Last EOD</h3>${d.lastEod ? `<p>${esc(d.lastEod.trade_date)} — ${esc(JSON.stringify(d.lastEod.summary))}</p>` : '<p class="muted">EOD has not run yet.</p>'}</div>`;
  },
  async kyc() {
    const list = await get(`/api/admin/kyc?status=${sub || 'submitted'}`);
    return `<div class="page-head"><h1>KYC review</h1></div><div class="card">${tabs('ks', [['submitted', 'Pending review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['draft', 'In progress']], sub || 'submitted')}
      ${list.length ? `<table class="tbl hover"><thead><tr><th>Applicant</th><th>PAN</th><th>Segments</th><th>Submitted</th><th>Status</th><th></th></tr></thead><tbody>${list.map((k) => `<tr><td><b>${esc(k.name)}</b><small class="block muted">${esc(k.email)} · ${esc(k.mobile)}</small></td><td>${esc(k.pan || '—')}<small class="block muted">${esc(k.pan_name || '')}</small></td><td>${esc((k.segments || []).join(', '))}</td><td class="muted">${k.submitted_at ? dt(k.submitted_at) : '—'}</td><td>${st(k.status)}</td><td class="r"><button class="btn xs" data-kyc="${k.user_id}">Open</button></td></tr>`).join('')}</tbody></table>` : empty('Nothing here.')}</div>`;
  },
  async clients() {
    const list = await get(`/api/admin/clients?q=${encodeURIComponent(sub)}`);
    return `<div class="page-head"><h1>Clients</h1><input id="cq" placeholder="Search name, email, mobile, UCC" value="${esc(sub)}"></div><div class="card"><div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>UCC</th><th>Name</th><th>Contact</th><th>Role</th><th>Status</th><th>KYC</th><th class="r">Cash</th><th>Joined</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr><td>${esc(c.ucc || '—')}</td><td><b>${esc(c.name)}</b></td><td class="small">${esc(c.email)}<br>${esc(c.mobile)}</td><td>${esc(c.role)}</td><td>${st(c.status)}${c.trading_blocked ? ' <span class="badge warn">blocked</span>' : ''}</td><td>${st(c.kyc_status || '—')}</td><td class="r">${inr(c.cash)}</td><td class="muted">${dt(c.created_at)}</td><td><button class="btn xs" data-client="${c.id}">Open</button></td></tr>`).join('')}</tbody></table></div></div>`;
  },
  async funds() {
    const list = await get(`/api/admin/funds?status=${sub === 'all' ? '' : sub || 'pending'}`);
    return `<div class="page-head"><h1>Fund requests</h1></div><div class="card">${tabs('fs', [['pending', 'Pending'], ['all', 'All']], sub || 'pending')}
      ${list.length ? `<table class="tbl"><thead><tr><th>Date</th><th>Client</th><th>Type</th><th class="r">Amount</th><th>Method / UTR</th><th>Status</th><th></th></tr></thead><tbody>${list.map((r) => `<tr><td class="muted">${dt(r.created_at)}</td><td>${esc(r.ucc || '')} · ${esc(r.name)}</td><td><span class="tag ${r.kind === 'PAYIN' ? 'buy' : 'sell'}">${r.kind}</span></td><td class="r">${inr(r.amount)}</td><td>${esc(r.method)} ${esc(r.utr || '')}</td><td>${st(r.status)}</td><td class="r nowrap">${r.status === 'pending' ? `<button class="btn xs buy" data-fund="${r.id}" data-a="approve">Approve</button> <button class="btn xs danger" data-fund="${r.id}" data-a="reject">Reject</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty('No requests.')}
      <p class="muted small">Approve pay-ins only after matching the UTR and amount in the client bank account statement. Payouts must be transferred to the client's registered bank account.</p></div>`;
  },
  async orders() {
    const [orders, trades] = await Promise.all([get('/api/admin/orders'), get('/api/admin/trades')]);
    return `<div class="page-head"><h1>Orders &amp; trades (today)</h1><button class="btn ghost sm" id="csvT">Export trades CSV</button></div>
      <div class="card"><h3>Orders</h3>${orders.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Client</th><th>Instrument</th><th>Side</th><th>Type</th><th>Product</th><th class="r">Qty</th><th class="r">Price</th><th>Status</th><th>Time</th></tr></thead><tbody>${orders.map((o) => `<tr><td>${o.id}</td><td>${esc(o.ucc)}</td><td>${esc(o.name)}</td><td><span class="tag ${o.side === 'BUY' ? 'buy' : 'sell'}">${o.side}</span></td><td>${o.order_type}${o.tag ? ` <small>${esc(o.tag)}</small>` : ''}</td><td>${o.product}</td><td class="r">${o.filled_qty}/${o.qty}</td><td class="r">${o.avg_price ? num(o.avg_price) : o.price ? num(o.price) : 'MKT'}</td><td>${st(o.status)}${o.status_message ? `<small class="block muted">${esc(o.status_message)}</small>` : ''}</td><td class="muted">${dt(o.created_at)}</td></tr>`).join('')}</tbody></table></div>` : empty('No orders today.')}</div>
      <div class="card"><h3>Trades</h3>${trades.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Trade ID</th><th>Client</th><th>Instrument</th><th>Side</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Charges</th></tr></thead><tbody>${trades.map((t) => `<tr><td class="small">${esc(t.exchange_trade_id)}</td><td>${esc(t.ucc)}</td><td>${esc(t.name)}</td><td>${t.side}</td><td class="r">${t.qty}</td><td class="r">${num(t.price)}</td><td class="r">${num(t.charges.total)}</td></tr>`).join('')}</tbody></table></div>` : empty('No trades today.')}</div>`;
  },
  async rms() {
    const [pos, ev] = await Promise.all([get('/api/admin/positions'), get('/api/admin/risk-events')]);
    return `<div class="page-head"><h1>Risk management</h1></div><div class="card"><h3>Clients with open positions</h3>${pos.length ? `<table class="tbl"><thead><tr><th>Client</th><th class="r">Ledger</th><th class="r">Used margin</th><th class="r">MTM</th><th class="r">Available</th><th class="r">MTM / margin</th><th></th></tr></thead><tbody>${pos.map((p) => { const ratio = p.funds.usedMargin ? (-Math.min(0, p.funds.mtm) / p.funds.usedMargin) * 100 : 0; return `<tr><td>${esc(p.ucc)} · ${esc(p.name)}<small class="block muted">${p.positions.filter((x) => x.qty).map((x) => `${esc(x.name)} ${x.qty}`).join(', ')}</small></td><td class="r">${inr(p.funds.cash)}</td><td class="r">${inr(p.funds.usedMargin)}</td><td class="r ${cls(p.funds.mtm)}">${signed(p.funds.mtm)}</td><td class="r ${cls(p.funds.available)}">${inr(p.funds.available)}</td><td class="r ${ratio > 60 ? 'down' : ''}">${ratio.toFixed(1)}%</td><td class="r"><button class="btn xs danger" data-sq="${p.user_id}">Square off</button></td></tr>`; }).join('')}</tbody></table>` : empty('No open positions.')}</div>
      <div class="card"><h3>Risk events</h3>${ev.length ? `<ul class="events">${ev.map((r) => `<li><b>${esc(r.kind)}</b> · ${esc(r.ucc || '')} — ${esc(r.message)} <small class="muted">${dt(r.created_at)}</small></li>`).join('')}</ul>` : empty('None.')}</div>`;
  },
  async ops() {
    const [s, eods] = await Promise.all([get('/api/admin/settings'), get('/api/admin/eod')]);
    return `<div class="page-head"><h1>Operations</h1></div><div class="grid2">
      <div class="card"><h3>Trading controls</h3>
        <div class="doc-up"><div><b>Kill switch</b><small class="block muted">Blocks all new orders platform-wide</small></div><button class="btn ${s.kill_switch ? 'buy' : 'danger'} sm" data-set="kill_switch" data-v="${!s.kill_switch}">${s.kill_switch ? 'Resume trading' : 'Halt trading'}</button></div>
        <div class="doc-up"><div><b>Market session</b><small class="block muted">auto = 9:15–15:30 IST weekdays (simulator override for testing)</small></div><select data-sel="market_mode">${['auto', 'open', 'closed'].map((m) => `<option ${s.market_mode === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <div class="doc-up"><div><b>After-market orders</b></div><button class="btn ghost sm" data-set="allow_amo" data-v="${!s.allow_amo}">${s.allow_amo ? 'Disable AMO' : 'Enable AMO'}</button></div>
        <div class="doc-up"><div><b>F&amp;O trading</b></div><button class="btn ghost sm" data-set="fno_enabled" data-v="${!s.fno_enabled}">${s.fno_enabled ? 'Disable F&O' : 'Enable F&O'}</button></div>
        <div class="doc-up"><div><b>Intraday square-off time</b></div><input data-inp="square_off_time" value="${esc(s.square_off_time)}" style="width:90px"></div>
        <div class="doc-up"><div><b>MTM square-off threshold (% of margin)</b></div><input data-inp="mtm_square_off_pct" type="number" value="${s.mtm_square_off_pct}" style="width:90px"></div>
        <div class="doc-up"><div><b>Lot sizes</b><small class="block muted">Verify against current exchange circulars</small></div><input data-json="lots" value='${esc(JSON.stringify(s.lots))}' style="width:220px"></div></div>
      <div class="card"><h3>End of day</h3><p class="muted">Runs automatically at 16:00 IST on weekdays. Cancels day orders, posts charges, generates contract notes, settles F&amp;O MTM / expiry and T+1 deliveries.</p><button class="btn" id="eod">Run EOD now</button>
        <ul class="events">${eods.map((e) => `<li><b>${esc(e.trade_date)}</b> ${esc(e.status)} <small class="muted">${esc(JSON.stringify(e.summary))}</small></li>`).join('')}</ul>
        <h3>Broadcast message</h3><form id="bc"><input name="title" placeholder="Title" required><textarea name="body" rows="2" placeholder="Message"></textarea><button class="btn ghost sm">Send to all clients</button></form>
        <h3>Simulator: set price</h3><form id="sp" class="row"><input name="token" placeholder="NSE:RELIANCE" required><input name="price" type="number" step="0.05" placeholder="Price" required style="width:120px"><button class="btn ghost sm">Set</button></form></div></div>`;
  },
  async ipo() {
    const [ipos, mfo] = await Promise.all([get('/api/admin/ipo'), get('/api/admin/mf-orders')]);
    return `<div class="page-head"><h1>IPO &amp; Mutual funds</h1></div>
      <div class="card"><h3>IPOs</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Issue</th><th>Band</th><th>Lot</th><th>Dates</th><th>State</th><th class="r">Applications</th><th class="r">Blocked</th><th></th></tr></thead><tbody>${ipos.map((i) => `<tr><td>${esc(i.name)} ${i.sample ? '<small class="muted">(sample)</small>' : ''}</td><td>₹${num(i.price_lo, 0)}–${num(i.price_hi, 0)}</td><td>${i.lot}</td><td class="small">${esc(i.open_date)} → ${esc(i.close_date)}</td><td>${st(i.state)}</td><td class="r">${i.applications}</td><td class="r">${inr(i.blocked)}</td><td>${i.state === 'CLOSED' ? `<button class="btn xs" data-allot="${i.id}">Run allotment</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <h4>Add IPO</h4><form id="ipoF" class="grid3"><input name="name" placeholder="Company name" required><input name="symbol" placeholder="NSE symbol (optional)"><select name="issue_type"><option>Mainboard</option><option>SME</option></select><input name="price_lo" type="number" placeholder="Price low" required><input name="price_hi" type="number" placeholder="Price high" required><input name="lot" type="number" placeholder="Lot size" required><input name="issue_size" placeholder="Issue size (e.g. ₹500 Cr)"><label>Open<input name="open_date" type="date" required></label><label>Close<input name="close_date" type="date" required></label><label>Listing<input name="listing_date" type="date"></label><button class="btn sm">Add IPO</button></form></div>
      <div class="card"><h3>Mutual fund orders</h3>${mfo.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Client</th><th>Scheme</th><th>Side</th><th class="r">Amount</th><th class="r">Units</th><th class="r">NAV</th></tr></thead><tbody>${mfo.map((o) => `<tr><td class="muted nowrap">${dt(o.created_at)}</td><td>${esc(o.ucc)}</td><td>${esc(o.name)}</td><td>${o.side}${o.sip_id ? ' (SIP)' : ''}</td><td class="r">${inr(o.amount)}</td><td class="r">${num(o.units, 3)}</td><td class="r">${num(o.nav, 2)}</td></tr>`).join('')}</tbody></table></div>` : empty('No MF orders yet.')}</div>`;
  },
  async audit() {
    const a = await get('/api/admin/audit');
    return `<div class="page-head"><h1>Audit log</h1><button class="btn ghost sm" id="csvA">Export CSV</button></div><div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Data</th><th>IP</th></tr></thead><tbody>${a.map((x) => `<tr><td class="muted nowrap">${dt(x.created_at)}</td><td>${esc(x.actor || x.actor_role)}</td><td>${esc(x.action)}</td><td>${esc(x.entity || '')} ${esc(x.entity_id || '')}</td><td class="small">${esc(x.data ? JSON.stringify(x.data).slice(0, 120) : '')}</td><td class="small">${esc(x.ip || '')}</td></tr>`).join('')}</tbody></table></div></div>`;
  },
};

async function openKyc(userId) {
  const d = await get(`/api/admin/kyc/${userId}`);
  const k = d.kyc;
  const m = modal(`<h3>KYC · ${esc(d.user.name)}</h3><div class="grid2"><dl class="dl">
    <dt>PAN</dt><dd>${esc(k.pan)}</dd><dt>Name on PAN</dt><dd>${esc(k.pan_name)}</dd><dt>DOB</dt><dd>${esc(k.dob)}</dd><dt>Gender</dt><dd>${esc(k.gender)}</dd><dt>Father/spouse</dt><dd>${esc(k.father_name)}</dd><dt>Income</dt><dd>${esc(k.income_range)}</dd><dt>Occupation</dt><dd>${esc(k.occupation)}</dd><dt>PEP</dt><dd>${k.pep ? 'Yes' : 'No'}</dd>
    <dt>Address</dt><dd>${esc([k.address.line1, k.address.line2, k.address.city, k.address.state, k.address.pincode].filter(Boolean).join(', '))}</dd><dt>Aadhaar</dt><dd>XXXX XXXX ${esc(k.aadhaar_last4)}</dd>
    <dt>Bank</dt><dd>${esc(k.bank.ifsc)} · ${esc(k.bank.account_no)} (${esc(k.bank.account_type)})</dd><dt>Nominee</dt><dd>${k.nominee.opt_out ? 'Opted out' : `${esc(k.nominee.name)} (${esc(k.nominee.relation)})`}</dd><dt>Segments</dt><dd>${esc(k.segments.join(', '))}</dd><dt>IPV / eSign</dt><dd>${k.ipv_done ? '✔' : '✘'} / ${k.esign_done ? '✔' : '✘'}</dd><dt>Mobile / email verified</dt><dd>${d.user.mobileVerified ? '✔' : '✘'} / ${d.user.emailVerified ? '✔' : '✘'}</dd></dl>
    <div><h4>Documents</h4>${d.documents.map((x) => `<div class="doc-up"><span>${esc(x.kind)} <small class="muted">${esc(x.filename)}</small></span><button class="btn xs ghost" data-doc="${x.id}">View</button></div>`).join('') || '<p class="muted">None</p>'}<div id="docView"></div></div></div>
    ${k.status === 'submitted' ? `<label>Remarks (required for rejection)<textarea id="rm" rows="2"></textarea></label><div class="row end"><button class="btn danger" data-rev="reject">Reject</button><button class="btn buy" data-rev="approve">Approve &amp; activate</button></div>` : `<p>Status: ${st(k.status)} ${esc(k.remarks || '')}</p>`}`, { wide: true });
  m.el.onclick = async (e) => {
    if (e.target.dataset.doc) {
      const r = await api(`/api/admin/kyc/doc/${e.target.dataset.doc}`, { raw: true });
      const blob = await r.blob(); const url = URL.createObjectURL(blob);
      m.el.querySelector('#docView').innerHTML = blob.type.startsWith('image/') ? `<img src="${url}" style="max-width:100%;border-radius:8px;margin-top:8px" alt="document">` : `<a class="btn sm" href="${url}" target="_blank" rel="noopener">Open PDF</a>`;
    }
    if (e.target.dataset.rev) {
      try { await post(`/api/admin/kyc/${userId}/review`, { action: e.target.dataset.rev, remarks: m.el.querySelector('#rm').value }); toast(`KYC ${e.target.dataset.rev}d`, 'success'); m.close(); render(); } catch (x) { toast(x.message, 'error'); }
    }
  };
}

async function openClient(id) {
  const d = await get(`/api/admin/clients/${id}`);
  const a = d.account, f = d.funds;
  const m = modal(`<h3>${esc(d.user.name)} <small class="muted">${esc(d.user.ucc || '')}</small></h3>
    <div class="stats">${[['Ledger', inr(f.cash)], ['Available', inr(f.available)], ['Used margin', inr(f.usedMargin)], ['MTM', signed(f.mtm)]].map(([k, v]) => `<div class="card stat"><small>${k}</small><b>${v}</b></div>`).join('')}</div>
    <div class="grid2"><div><h4>Limits</h4><form id="lim"><label>Max order value (₹)<input name="maxOrderValue" type="number" value="${a.max_order_value}"></label><label>F&amp;O daily loss limit (₹)<input name="fnoLossLimit" type="number" value="${a.fno_loss_limit}"></label><label class="chip"><input type="checkbox" name="tradingBlocked" ${a.trading_blocked ? 'checked' : ''}> Block trading</label><br><br><button class="btn sm">Save limits</button></form></div>
    <div><h4>Actions</h4><div class="row"><button class="btn sm danger" data-act="sq">Square off positions</button>${d.user.status === 'active' ? '<button class="btn sm ghost" data-st="suspended">Suspend</button>' : '<button class="btn sm ghost" data-st="active">Activate</button>'}</div>
      ${me.role === 'admin' ? `<h4>Role</h4><div class="row"><select id="role">${['client', 'support', 'ops', 'rms', 'admin'].map((r) => `<option ${d.user.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select><button class="btn sm ghost" data-act="role">Change role</button></div>` : ''}</div></div>
    <h4>Positions</h4>${d.positions.length ? `<table class="tbl">${d.positions.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.product}</td><td class="r">${p.qty}</td><td class="r ${cls(p.pnl)}">${signed(p.pnl)}</td></tr>`).join('')}</table>` : '<p class="muted">None</p>'}
    <h4>Holdings</h4>${d.holdings.length ? `<table class="tbl">${d.holdings.map((h) => `<tr><td>${esc(h.symbol)}</td><td class="r">${h.total}</td><td class="r">${inr(h.current)}</td></tr>`).join('')}</table>` : '<p class="muted">None</p>'}
    <h4>Recent orders</h4>${d.orders.length ? `<table class="tbl">${d.orders.slice(0, 15).map((o) => `<tr><td>${esc(o.name)}</td><td>${o.side} ${o.qty}</td><td>${st(o.status)}</td><td class="muted">${dt(o.created_at)}</td></tr>`).join('')}</table>` : '<p class="muted">None</p>'}`, { wide: true });
  m.el.querySelector('#lim').onsubmit = async (e) => { e.preventDefault(); const f2 = e.target; await put(`/api/admin/clients/${id}/limits`, { maxOrderValue: +f2.maxOrderValue.value, fnoLossLimit: +f2.fnoLossLimit.value, tradingBlocked: f2.tradingBlocked.checked }); toast('Limits saved', 'success'); };
  m.el.onclick = async (e) => {
    const t = e.target;
    try {
      if (t.dataset.act === 'sq' && (await confirmBox('Square off all MIS/NRML positions of this client at market?'))) { await post(`/api/admin/clients/${id}/square-off`, { reason: 'Squared off by RMS desk' }); toast('Square-off orders placed', 'success'); }
      if (t.dataset.st && (await confirmBox(`Set client status to ${t.dataset.st}?`))) { await post(`/api/admin/clients/${id}/status`, { status: t.dataset.st }); toast('Updated', 'success'); m.close(); render(); }
      if (t.dataset.act === 'role') { await post(`/api/admin/clients/${id}/role`, { role: m.el.querySelector('#role').value }); toast('Role changed', 'success'); }
    } catch (x) { toast(x.message, 'error'); }
  };
}

async function render() {
  view = (location.hash.slice(1) || 'dashboard').split('?')[0];
  if (!VIEWS[view]) view = 'dashboard';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === view));
  const main = $('#main');
  main.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try { main.innerHTML = `<section class="page">${await VIEWS[view]()}</section>`; }
  catch (e) { if (e.status === 401) { session.clear(); return loginScreen(); } main.innerHTML = `<section class="page"><h1>Error</h1><p class="err">${esc(e.message)}</p></section>`; }
}

function bind() {
  const main = $('#main');
  main.onclick = async (e) => {
    const d = e.target.dataset;
    try {
      if (d.tab) { sub = d.tab; return render(); }
      if (d.kyc) return openKyc(d.kyc);
      if (d.client) return openClient(d.client);
      if (d.fund) { const remarks = d.a === 'reject' ? prompt('Reason for rejection') : null; if (d.a === 'reject' && !remarks) return; await post(`/api/admin/funds/${d.fund}`, { action: d.a, remarks }); toast(`Request ${d.a}d`, 'success'); return render(); }
      if (d.sq && (await confirmBox('Square off this client?'))) { await post(`/api/admin/clients/${d.sq}/square-off`, {}); toast('Square-off placed', 'success'); return render(); }
      if (d.set) { await put(`/api/admin/settings/${d.set}`, { value: d.v === 'true' }); toast('Updated', 'success'); return render(); }
      if (e.target.id === 'eod' && (await confirmBox('Run end-of-day processing now?'))) { const s = await post('/api/admin/eod', { force: true }); toast(`EOD done: ${JSON.stringify(s)}`, 'success', 8000); return render(); }
      if (d.allot) { const pct = prompt('Allotment ratio % (each applicant gets 1 lot with this probability)', '30'); if (!pct) return; const lp = prompt('Listing price (optional)', ''); const r = await post(`/api/admin/ipo/${d.allot}/allot`, { pct: Number(pct), listingPrice: lp ? Number(lp) : undefined }); toast(`Allotted ${r.allotted} of ${r.applications}`, 'success'); return render(); }
      if (e.target.id === 'csvT') downloadCSV('trades.csv', await get('/api/admin/trades'));
      if (e.target.id === 'csvA') downloadCSV('audit.csv', await get('/api/admin/audit'));
    } catch (x) { toast(x.message, 'error', 6000); }
  };
  main.onchange = async (e) => {
    const t = e.target;
    try {
      if (t.dataset.sel) { await put(`/api/admin/settings/${t.dataset.sel}`, { value: t.value }); toast('Updated', 'success'); }
      if (t.dataset.inp) { await put(`/api/admin/settings/${t.dataset.inp}`, { value: t.type === 'number' ? Number(t.value) : t.value }); toast('Updated', 'success'); }
      if (t.dataset.json) { await put(`/api/admin/settings/${t.dataset.json}`, { value: JSON.parse(t.value) }); toast('Updated', 'success'); }
      if (t.id === 'cq') { sub = t.value; render(); }
    } catch (x) { toast(x.message, 'error'); }
  };
  main.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      if (e.target.id === 'ipoF') { await post('/api/admin/ipo', f); toast('IPO added', 'success'); return render(); }
      if (e.target.id === 'bc') { await post('/api/admin/broadcast', f); toast('Broadcast sent', 'success'); e.target.reset(); }
      if (e.target.id === 'sp') { const q = await post('/api/admin/price', { token: f.token, price: Number(f.price) }); toast(`${f.token} → ${q.ltp}`, 'success'); }
    } catch (x) { toast(x.message, 'error'); }
  };
}

(async () => {
  document.documentElement.dataset.theme = 'dark';
  if (!session.refresh) return loginScreen();
  try { me = (await get('/api/me')).user; } catch { session.clear(); return loginScreen(); }
  if (me.role === 'client') { session.clear(); return loginScreen('This console is for broker staff only.'); }
  shell(); bind();
  window.addEventListener('hashchange', () => { sub = ''; render(); });
  render();
})();
