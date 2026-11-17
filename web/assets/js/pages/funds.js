import { App, rerender } from '../app.js';
import { get, post, del } from '../api.js';
import { esc, inr, signed, cls, dt, toast, empty } from '../ui.js';

export default {
  title: 'Funds', auth: true, active: true,
  async render() {
    const [f, reqs, bank, ledger] = await Promise.all([get('/api/funds'), get('/api/funds/requests'), get('/api/funds/bank'), get('/api/reports/ledger')]);
    return `<section class="page"><div class="page-head"><h1>Funds</h1></div><div class="grid2">
      <div class="card"><h3>Equity &amp; F&amp;O</h3><div class="big">${inr(f.available)}<small>Available margin</small></div>
        <dl class="dl"><dt>Ledger balance</dt><dd>${inr(f.cash)}</dd><dt>Used margin (positions)</dt><dd>${inr(f.usedMargin)}</dd><dt>Blocked for open orders</dt><dd>${inr(f.openOrders)}</dd>
        <dt>Unrealised MTM</dt><dd class="${cls(f.mtm)}">${signed(f.mtm)}</dd><dt>Today's charges (accrued)</dt><dd>${inr(f.accruedCharges)}</dd><dt>Unsettled sell credit</dt><dd>${inr(f.unsettledCredit)}</dd><dt>Pending withdrawal</dt><dd>${inr(f.payoutHold)}</dd><dt><b>Withdrawable</b></dt><dd><b>${inr(f.withdrawable)}</b></dd></dl></div>
      <div class="card"><h3>Add funds</h3><p class="muted small">Transfer only from your registered bank account <b>${esc(bank.ifsc || '')} ${esc(bank.account_no || '')}</b>. Pay via UPI / IMPS / NEFT to the broker's client bank account, then enter the reference number.</p>
        <form id="payin"><div class="form-grid"><label>Amount (₹)<input name="amount" type="number" min="100" required></label><label>Method<select name="method"><option>UPI</option><option>IMPS</option><option>NEFT</option></select></label></div><label>UTR / transaction reference<input name="utr" required minlength="8" maxlength="30"></label><button class="btn buy">Submit pay-in</button></form>
        <h3 style="margin-top:20px">Withdraw</h3><form id="payout" class="row"><input name="amount" type="number" min="1" max="${f.withdrawable}" placeholder="Up to ${inr(f.withdrawable)}" required aria-label="Withdraw amount"><button class="btn ghost">Request withdrawal</button></form>
        <p class="muted small">Withdrawals are processed to your registered bank account after approval. Sell proceeds are withdrawable after settlement (T+1).</p></div></div>
      <div class="card"><h3>Requests</h3>${reqs.length ? `<table class="tbl"><thead><tr><th>Date</th><th>Type</th><th class="r">Amount</th><th>Reference</th><th>Status</th><th></th></tr></thead><tbody>${reqs.map((r) => `<tr><td class="muted">${dt(r.created_at)}</td><td>${r.kind}</td><td class="r">${inr(r.amount)}</td><td>${esc(r.utr || r.method)}</td><td><span class="st ${r.status === 'approved' ? 'COMPLETE' : r.status === 'pending' ? 'OPEN' : 'REJECTED'}">${r.status}</span>${r.remarks ? `<small class="block muted">${esc(r.remarks)}</small>` : ''}</td><td>${r.status === 'pending' ? `<button class="btn xs ghost" data-cx="${r.id}">Cancel</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty('No fund requests yet.')}</div>
      <div class="card"><h3>Ledger</h3>${ledger.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Type</th><th>Narration</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead><tbody>${ledger.slice(0, 100).map((l) => `<tr><td class="muted">${esc(l.entry_date)}</td><td>${esc(l.type)}</td><td>${esc(l.narration)}</td><td class="r down">${l.debit ? inr(l.debit) : ''}</td><td class="r up">${l.credit ? inr(l.credit) : ''}</td><td class="r">${inr(l.balance)}</td></tr>`).join('')}</tbody></table></div>` : empty('No ledger entries yet.')}</div></section>`;
  },
  mount(root) {
    const sub = (id, fn) => (root.querySelector(id).onsubmit = async (e) => { e.preventDefault(); try { await fn(Object.fromEntries(new FormData(e.target))); rerender(); App.refreshFunds(); } catch (x) { toast(x.message, 'error', 5000); } });
    sub('#payin', async (d) => { await post('/api/funds/payin', d); toast('Pay-in submitted. It will reflect after verification.', 'success'); });
    sub('#payout', async (d) => { await post('/api/funds/payout', d); toast('Withdrawal requested', 'success'); });
    root.onclick = async (e) => { if (e.target.dataset.cx) { await del(`/api/funds/requests/${e.target.dataset.cx}`); rerender(); } };
  },
};
