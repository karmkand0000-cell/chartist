import { App, rerender } from '../app.js';
import { get, post, del } from '../api.js';
import { esc, num, inr, pct, cls, modal, toast, empty, tabs, confirmBox } from '../ui.js';

let tab = 'OPEN';
const dt = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : 'TBA');
export default {
  title: 'IPO',
  async render() {
    const list = await get('/api/ipo');
    const show = list.filter((i) => (tab === 'CLOSED' ? ['CLOSED', 'ALLOTTED', 'LISTED'].includes(i.state) : i.state === tab));
    const mine = list.filter((i) => i.application);
    return `<section class="page"><div class="page-head"><h1>IPO</h1>${list.some((i) => i.sample) ? '<span class="badge warn">Includes sample listings</span>' : ''}</div>
      ${mine.length ? `<div class="card"><h3>My applications</h3><table class="tbl"><thead><tr><th>IPO</th><th class="r">Lots</th><th class="r">Bid</th><th class="r">Amount blocked</th><th>Status</th><th></th></tr></thead><tbody>${mine.map((i) => { const a = i.application; return `<tr><td>${esc(i.name)}</td><td class="r">${a.lots}</td><td class="r">${num(a.price)}</td><td class="r">${inr(a.amount)}</td><td><span class="st ${a.status === 'ALLOTTED' ? 'COMPLETE' : a.status === 'APPLIED' ? 'OPEN' : 'REJECTED'}">${a.status.replace('_', ' ')}</span></td><td class="r">${a.status === 'APPLIED' && i.state === 'OPEN' ? `<button class="btn xs ghost" data-cancel="${i.id}">Withdraw</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>` : ''}
      <div class="card">${tabs('ipo', [['OPEN', 'Open'], ['UPCOMING', 'Upcoming'], ['CLOSED', 'Closed / listed']], tab)}
      ${show.length ? `<div class="ipo-grid">${show.map((i) => `<div class="ipo-card"><div class="row between"><b>${esc(i.name)}</b><span class="tag">${esc(i.issue_type)}</span></div>
        <div class="kv small"><div><small>Price band</small><b>₹${num(i.price_lo, 0)}–${num(i.price_hi, 0)}</b></div><div><small>Lot</small><b>${i.lot} shares</b></div><div><small>Min. amount</small><b>${inr(i.lot * i.price_hi)}</b></div><div><small>Issue size</small><b>${esc(i.issue_size || '—')}</b></div></div>
        <div class="timeline"><span>Open<b>${dt(i.open_date)}</b></span><span>Close<b>${dt(i.close_date)}</b></span><span>Listing<b>${dt(i.listing_date)}</b></span></div>
        ${i.listing_price ? `<p>Listed at ${num(i.listing_price)} <b class="${cls(i.listing_price - i.price_hi)}">${pct((i.listing_price / i.price_hi - 1) * 100)}</b></p>` : ''}
        ${i.state === 'OPEN' ? (i.application?.status === 'APPLIED' ? '<span class="tag buy">Applied ✓</span>' : `<button class="btn sm block" data-apply="${i.id}">Apply</button>`) : ''}</div>`).join('')}</div>` : empty('No IPOs in this list right now.')}
      <p class="muted small">Simulator: application amount is blocked from your trading balance and released if not allotted. In production the block happens in your bank account through a UPI mandate (ASBA).</p></div></section>`;
  },
  async mount(root) {
    const list = await get('/api/ipo');
    root.querySelector('[data-tabs="ipo"]').onclick = (e) => { if (e.target.dataset.tab) { tab = e.target.dataset.tab; rerender(); } };
    root.onclick = async (e) => {
      const d = e.target.dataset;
      if (d.apply) {
        if (!App.user) return App.go('login');
        if (App.user.status !== 'active') return App.go('onboarding');
        const i = list.find((x) => x.id === +d.apply);
        const m = modal(`<h3>Apply · ${esc(i.name)}</h3><form id="f"><div class="grid3"><label>Lots<input name="lots" type="number" min="1" max="14" value="1"></label><label>Bid price<input name="price" type="number" min="${i.price_lo}" max="${i.price_hi}" value="${i.price_hi}"></label><label class="chip"><input type="checkbox" name="cutoff" checked> Cut-off</label></div>
          <label>UPI ID<input name="upiId" placeholder="name@okhdfcbank" required></label><p class="muted small">Amount = lots × ${i.lot} × price. Retail limit ₹2,00,000.</p><p class="form-err" id="er"></p><div class="row end"><button class="btn">Submit application</button></div></form>`);
        m.el.querySelector('#f').onsubmit = async (ev) => {
          ev.preventDefault(); const v = Object.fromEntries(new FormData(ev.target));
          try { await post(`/api/ipo/${i.id}/apply`, { lots: v.lots, price: v.price, cutoff: !!v.cutoff, upiId: v.upiId }); toast('Application submitted', 'success'); m.close(); rerender(); }
          catch (x) { m.el.querySelector('#er').textContent = x.message; }
        };
      }
      if (d.cancel && (await confirmBox('Withdraw this IPO application? The blocked amount will be released.'))) { try { await del(`/api/ipo/${d.cancel}/apply`); toast('Application withdrawn'); rerender(); } catch (x) { toast(x.message, 'error'); } }
    };
  },
};
