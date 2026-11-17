import { App, orderWindow, addToWatchlist } from '../app.js';
import { get, post, live } from '../api.js';
import { esc, num, pct, cls, compact, modal, toast } from '../ui.js';
import * as IND from '../../../shared/indicators.js';

let chart = null, series = {}, rows = [], token = '', tf = '1Y', ctype = 'candle', unsub = null, inst = null;
const ind = { sma20: true, sma50: true, bb: false, vol: true, rsi: true, macd: false };
const TF = { '1M': 22, '3M': 66, '6M': 130, '1Y': 252, ALL: 1e9 };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function build(el) {
  if (chart) chart.remove();
  const L = window.LightweightCharts; if (!L || !rows.length) return;
  const data = rows.slice(-TF[tf]);
  chart = L.createChart(el, { autoSize: true, layout: { background: { color: 'transparent' }, textColor: css('--muted'), panes: { separatorColor: css('--line') } }, grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } }, rightPriceScale: { borderColor: css('--line') }, timeScale: { borderColor: css('--line') } });
  series = {};
  if (ctype === 'line') { series.main = chart.addSeries(L.AreaSeries, { lineColor: css('--brand'), topColor: 'rgba(46,125,246,.3)', bottomColor: 'rgba(46,125,246,0)', lineWidth: 2 }); series.main.setData(data.map((r) => ({ time: r.time, value: r.close }))); }
  else { series.main = chart.addSeries(L.CandlestickSeries, { upColor: css('--up'), downColor: css('--down'), wickUpColor: css('--up'), wickDownColor: css('--down'), borderVisible: false }); series.main.setData(data); }
  const c = data.map((r) => r.close);
  const line = (v, color, pane = 0) => { const s = chart.addSeries(L.LineSeries, { color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false }, pane); s.setData(data.map((r, i) => (v[i] == null ? { time: r.time } : { time: r.time, value: v[i] }))); return s; };
  if (ind.sma20) line(IND.sma(c, 20), '#F59F00');
  if (ind.sma50) line(IND.sma(c, 50), '#7048E8');
  if (ind.bb) { const b = IND.bollinger(c); line(b.upper, '#868E96'); line(b.lower, '#868E96'); }
  if (ind.vol) { const v = chart.addSeries(L.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false }); v.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } }); v.setData(data.map((r) => ({ time: r.time, value: r.volume, color: r.close >= r.open ? 'rgba(18,184,134,.35)' : 'rgba(240,62,62,.35)' }))); }
  let pane = 1;
  if (ind.rsi) { const s = line(IND.rsi(c), '#E64980', pane++); s.createPriceLine({ price: 70, color: css('--muted'), lineStyle: 2, axisLabelVisible: false }); s.createPriceLine({ price: 30, color: css('--muted'), lineStyle: 2, axisLabelVisible: false }); }
  if (ind.macd) { const m = IND.macd(c); line(m.line, '#2E7DF6', pane); line(m.signal, '#F59F00', pane++); }
  chart.panes().forEach((p, i) => i && p.setHeight(90));
  chart.timeScale().fitContent();
}

export default {
  title: (r) => decodeURIComponent(r.params[0] || ''),
  async render(r) {
    token = r.params[0];
    inst = await get(`/api/instruments/${encodeURIComponent(token)}`);
    const q = inst.quote;
    live.quotes.set(token, { ...(live.quotes.get(token) || {}), ...q });
    unsub?.(); unsub = live.sub([token]);
    rows = inst.segment === 'FO' ? [] : await get(`/api/candles/${encodeURIComponent(token)}?days=800`);
    const tech = rows.length > 50 ? IND.technicalSummary(rows.map((x) => x.close)) : null;
    const tradable = inst.segment !== 'IDX';
    const fo = inst.segment === 'FO';
    const range = (q.w52h || 0) - (q.w52l || 0);
    return `<section class="page stock"><div class="stock-head"><div><h1>${esc(inst.name)} <small class="muted">${esc(fo ? 'NFO' : inst.exchange)}${fo ? ` · Lot ${inst.lot} · Expiry ${esc(inst.expiry)}` : ''}</small></h1>
      <div class="px"><b data-ltp="${esc(token)}">${num(q.ltp)}</b><em class="${cls(q.change)}" data-chg="${esc(token)}" data-mode="abs">${q.change >= 0 ? '+' : ''}${num(q.change)} (${pct(q.pct)})</em></div></div>
      <div class="row">${tradable ? '<button class="btn buy lg" id="bB">Buy</button><button class="btn sell lg" id="bS">Sell</button>' : `<a class="btn" href="#/fno?u=${inst.symbol === 'BANKNIFTY' ? 'BANKNIFTY' : 'NIFTY'}">Option chain</a>`}
      <button class="btn ghost" id="bW">+ Watchlist</button>${inst.segment === 'EQ' ? '<button class="btn ghost" id="bG">GTT</button>' : ''}<button class="btn ghost" id="bA">🔔 Alert</button></div></div>
      ${rows.length ? `<div class="card chart-card"><div class="chart-tools"><div class="seg sm">${Object.keys(TF).map((k) => `<button data-tf="${k}" class="${k === tf ? 'on' : ''}">${k}</button>`).join('')}</div><div class="seg sm">${[['candle', 'Candles'], ['line', 'Line']].map(([k, l]) => `<button data-ct="${k}" class="${k === ctype ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="chips">${[['sma20', 'SMA 20'], ['sma50', 'SMA 50'], ['bb', 'Bollinger'], ['vol', 'Volume'], ['rsi', 'RSI'], ['macd', 'MACD']].map(([k, l]) => `<label class="chip"><input type="checkbox" data-ind="${k}" ${ind[k] ? 'checked' : ''}>${l}</label>`).join('')}</div></div><div id="chart" class="chart"></div></div>` : ''}
      <div class="grid2"><div class="card"><h3>Market depth</h3><div class="depth"><div><small class="muted">Bid</small><table class="tbl"><tbody>${[0, 1, 2, 3, 4].map((i) => `<tr><td class="up">${num(q.bid - i * 0.05)}</td><td class="r">${compact(200 + ((i * 137) % 900))}</td></tr>`).join('')}</tbody></table></div><div><small class="muted">Offer</small><table class="tbl"><tbody>${[0, 1, 2, 3, 4].map((i) => `<tr><td class="down">${num(q.ask + i * 0.05)}</td><td class="r">${compact(180 + ((i * 211) % 900))}</td></tr>`).join('')}</tbody></table></div></div><small class="muted">Simulator depth is indicative.</small></div>
      <div class="card"><div class="kv">${[['Open', num(q.open)], ['High', num(q.high)], ['Low', num(q.low)], ['Prev close', num(q.close)], ['Volume', compact(q.volume)], ['Upper circuit', q.upper ? num(q.upper) : '—'], ['Lower circuit', q.lower ? num(q.lower) : '—'], ['Tick size', num(inst.tick)]].map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('')}</div>
      ${tech ? `<h4>Technical view <span class="tag ${tech.score > 0 ? 'buy' : tech.score < 0 ? 'sell' : ''}">${tech.verdict}</span></h4><ul class="events">${tech.signals.map((s) => `<li>${esc(s.label)} — <b class="${s.bullish ? 'up' : 'down'}">${s.note || (s.bullish ? 'Bullish' : 'Bearish')}</b></li>`).join('')}</ul><small class="muted">Educational indicators, not a recommendation.</small>` : ''}</div></div></section>`;
  },
  mount(root) {
    const el = root.querySelector('#chart');
    if (el) {
      build(el);
      root.querySelector('.chart-tools').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.tf) tf = b.dataset.tf; if (b.dataset.ct) ctype = b.dataset.ct; root.querySelectorAll('[data-tf],[data-ct]').forEach((x) => x.classList.toggle('on', x.dataset.tf === tf || x.dataset.ct === ctype)); build(el); };
      root.querySelectorAll('[data-ind]').forEach((c) => (c.onchange = () => { ind[c.dataset.ind] = c.checked; build(el); }));
      this._t = () => build(el); window.addEventListener('themechange', this._t);
    }
    const on = (id, fn) => { const b = root.querySelector(id); if (b) b.onclick = fn; };
    on('#bB', () => orderWindow(token, 'BUY')); on('#bS', () => orderWindow(token, 'SELL')); on('#bW', () => addToWatchlist(token));
    on('#bA', () => {
      if (!App.user) return App.go('login');
      const q = live.quotes.get(token);
      const m = modal(`<h3>Price alert · ${esc(inst.symbol)}</h3><form id="af" class="grid3"><label>When price is<select name="direction"><option value="above">Above</option><option value="below">Below</option></select></label><label>Price<input name="price" type="number" step="0.05" value="${(q.ltp * 1.02).toFixed(2)}"></label><div class="row end"><button class="btn">Create alert</button></div></form>`);
      m.el.querySelector('#af').onsubmit = async (e) => { e.preventDefault(); try { await post('/api/alerts', { token, ...Object.fromEntries(new FormData(e.target)) }); toast('Alert created', 'success'); m.close(); } catch (x) { toast(x.message, 'error'); } };
    });
    on('#bG', () => {
      if (!App.user) return App.go('login');
      const q = live.quotes.get(token);
      const m = modal(`<h3>Create GTT · ${esc(inst.symbol)}</h3><p class="muted">Good Till Triggered order — valid for 1 year. LTP ${num(q.ltp)}</p><form id="gf">
        <div class="seg wide"><label><input type="radio" name="kind" value="SINGLE" checked> Single</label><label><input type="radio" name="kind" value="OCO"> OCO (target + stop-loss sell)</label></div>
        <div id="gS" class="grid3"><label>Side<select name="side"><option>BUY</option><option>SELL</option></select></label><label>Trigger<input name="trigger_price" type="number" step="0.05" value="${(q.ltp * 0.97).toFixed(2)}"></label><label>Limit price<input name="limit_price" type="number" step="0.05" value="${(q.ltp * 0.97).toFixed(2)}"></label></div>
        <div id="gO" class="grid3" hidden><label>Stop-loss<input name="stoploss" type="number" step="0.05" value="${(q.ltp * 0.95).toFixed(2)}"></label><label>Target<input name="target" type="number" step="0.05" value="${(q.ltp * 1.1).toFixed(2)}"></label></div>
        <label>Quantity<input name="qty" type="number" min="1" value="1"></label><p class="form-err" id="gErr"></p><div class="row end"><button class="btn">Create GTT</button></div></form>`);
      const f = m.el.querySelector('#gf');
      f.onchange = () => { const o = f.kind.value === 'OCO'; m.el.querySelector('#gO').hidden = !o; m.el.querySelector('#gS').hidden = o; };
      f.onsubmit = async (e) => { e.preventDefault(); try { await post('/api/gtt', { token, ...Object.fromEntries(new FormData(f)) }); toast('GTT created', 'success'); m.close(); } catch (x) { m.el.querySelector('#gErr').textContent = x.message; } };
    });
  },
  onTick() {
    const q = live.quotes.get(token);
    if (!chart || !series.main || !rows.length || !q?.ltp) return;
    const last = { ...rows.at(-1) };
    last.close = q.ltp; last.high = Math.max(last.high, q.ltp); last.low = Math.min(last.low, q.ltp);
    try { series.main.update(ctype === 'line' ? { time: last.time, value: q.ltp } : last); } catch { /* ignore */ }
  },
  unmount() { chart?.remove(); chart = null; unsub?.(); unsub = null; if (this._t) window.removeEventListener('themechange', this._t); },
};
