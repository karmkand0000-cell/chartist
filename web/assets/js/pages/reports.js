import { get } from '../api.js';
import { CONFIG } from '../config.js';
import { session } from '../api.js';
import { esc, inr, signed, cls, tabs, empty, num, downloadCSV, toast } from '../ui.js';
import { rerender } from '../app.js';

let tab = 'pnl';
export default {
  title: 'Reports', auth: true, active: true,
  async render() {
    let body = '';
    if (tab === 'pnl') {
      const p = await get('/api/reports/pnl');
      body = `<div class="stats">${[['Intraday equity', p.intraday], ['Delivery equity', p.delivery], ['F&O', p.fno], ['Charges', -p.charges], ['Net realised P&L', p.net]].map(([k, v]) => `<div class="card stat"><small>${k}</small><b class="${cls(v)}">${signed(v)}</b></div>`).join('')}</div>
        ${p.scrips.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Instrument</th><th>Category</th><th class="r">Buy qty</th><th class="r">Sell qty</th><th class="r">Realised P&amp;L</th><th class="r">Charges</th></tr></thead><tbody>${p.scrips.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.category}</td><td class="r">${s.buyQty}</td><td class="r">${s.sellQty}</td><td class="r ${cls(s.pnl)}">${signed(s.pnl)}</td><td class="r">${num(s.charges)}</td></tr>`).join('')}</tbody></table></div>` : empty('No trades yet.')}<p class="muted small">${esc(p.taxNote)}</p>`;
    } else if (tab === 'ledger') {
      const l = await get('/api/reports/ledger');
      body = l.length ? `<div class="row end"><button class="btn xs ghost" id="csv">Export CSV</button></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Type</th><th>Narration</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead><tbody>${l.map((x) => `<tr><td>${esc(x.entry_date)}</td><td>${esc(x.type)}</td><td>${esc(x.narration)}</td><td class="r">${x.debit ? inr(x.debit) : ''}</td><td class="r">${x.credit ? inr(x.credit) : ''}</td><td class="r">${inr(x.balance)}</td></tr>`).join('')}</tbody></table></div>` : empty('No entries.');
      this._csv = l;
    } else {
      const c = await get('/api/reports/contract-notes');
      body = c.length ? `<table class="tbl"><thead><tr><th>Trade date</th><th>Contract note no.</th><th class="r">Trades</th><th class="r">Charges</th><th class="r">Net</th><th></th></tr></thead><tbody>${c.map((x) => `<tr><td>${esc(x.trade_date)}</td><td>${esc(x.number)}</td><td class="r">${x.totals.trades}</td><td class="r">${inr(x.totals.total)}</td><td class="r ${cls(x.totals.netObligation)}">${signed(x.totals.netObligation)}</td><td class="r"><button class="btn xs ghost" data-cn="${x.id}">View</button></td></tr>`).join('')}</tbody></table>` : empty('Contract notes are generated after end-of-day processing on days you trade.');
    }
    return `<section class="page"><div class="page-head"><h1>Reports</h1></div><div class="card">${tabs('r', [['pnl', 'P&L'], ['ledger', 'Ledger'], ['cn', 'Contract notes']], tab)}${body}</div></section>`;
  },
  mount(root) {
    root.querySelector('[data-tabs="r"]').onclick = (e) => { if (e.target.dataset.tab) { tab = e.target.dataset.tab; rerender(); } };
    root.onclick = async (e) => {
      if (e.target.id === 'csv') downloadCSV('ledger.csv', this._csv);
      if (e.target.dataset.cn) {
        const r = await fetch(`${CONFIG.API_BASE}/api/reports/contract-notes/${e.target.dataset.cn}`, { headers: { Authorization: `Bearer ${session.access}` } });
        if (!r.ok) return toast('Could not open contract note', 'error');
        const w = window.open('', '_blank'); if (w) { w.document.write(await r.text()); w.document.close(); }
      }
    };
  },
};
