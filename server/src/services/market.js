// Market data: quote cache, simulated tick feed (or Yahoo delayed base prices), candles, market status
import { EventEmitter } from 'node:events';
import { db } from '../db.js';
import { config } from '../config.js';
import { getSetting } from './settings.js';
import { allInstruments, getInstrument, DERIV, universe } from './instruments.js';
import { optionPremium, yearsTo } from '../../../shared/options.js';
import { r2, roundTick, istParts, isWeekday, parseToken } from '../../../shared/util.js';

export const bus = new EventEmitter();
bus.setMaxListeners(0);
const Q = new Map();          // token → quote (cash instruments)
let timer = null;

export function marketStatus(now = new Date()) {
  const mode = getSetting('market_mode');
  if (mode === 'open') return 'OPEN';
  if (mode === 'closed') return 'CLOSED';
  const { hm } = istParts(now);
  if (!isWeekday(now)) return 'CLOSED';
  if (hm >= '09:00' && hm < '09:15') return 'PRE_OPEN';
  if (hm >= '09:15' && hm < '15:30') return 'OPEN';
  return 'CLOSED';
}
export const isOpen = () => marketStatus() === 'OPEN';

function band(inst, prev) {
  if (!inst.band_pct) return { upper: null, lower: null };
  return { upper: roundTick(prev * (1 + inst.band_pct / 100)), lower: roundTick(prev * (1 - inst.band_pct / 100)) };
}

// Seed ~2 years of daily candles so charts work from day one (replaced by real candles as the system runs)
async function seedCandles(inst, last) {
  const have = await db.one('select count(*)::int c from candles where token=$1', [inst.token]);
  if (have.c > 0) return;
  const vol = inst.segment === 'IDX' ? 0.009 : 0.016;
  const n = 500, closes = [last];
  for (let i = 0; i < n - 1; i++) closes.push(closes.at(-1) / Math.exp((Math.random() - 0.5) * 2 * vol * 1.7 + 0.0003));
  closes.reverse();
  const days = [];
  const d = new Date(`${istParts().date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  while (days.length < n) { if (d.getUTCDay() % 6 !== 0) days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  days.reverse();
  const rows = closes.map((c, i) => {
    const o = i ? closes[i - 1] * (1 + (Math.random() - 0.5) * vol / 2) : c;
    return [days[i], r2(o), r2(Math.max(o, c) * (1 + Math.random() * vol / 2)), r2(Math.min(o, c) * (1 - Math.random() * vol / 2)), r2(c), Math.round((0.5 + Math.random()) * 4e6)];
  });
  const values = rows.map((_, i) => `($1,$${i * 6 + 2},$${i * 6 + 3},$${i * 6 + 4},$${i * 6 + 5},$${i * 6 + 6},$${i * 6 + 7})`).join(',');
  await db.query(`insert into candles(token, day, open, high, low, close, volume) values ${values} on conflict do nothing`, [inst.token, ...rows.flat()]);
}

export async function initMarket() {
  for (const inst of allInstruments().filter((i) => i.segment !== 'FO')) {
    const last = await db.one('select close from candles where token=$1 order by day desc limit 1', [inst.token]);
    const base = last?.close || inst.base_price || 100;
    if (!last) await seedCandles(inst, base);
    const prev = (await db.one('select close from candles where token=$1 order by day desc limit 1', [inst.token]))?.close || base;
    Q.set(inst.token, { token: inst.token, ltp: prev, open: prev, high: prev, low: prev, close: prev, volume: 0, ...band(inst, prev), ts: Date.now(), base: prev });
  }

}

// ── Simulated feed: mean-reverting random walk around the reference price
function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function step() {
  const open = isOpen();
  if (!open && !config.simAlwaysTick) return;
  const moved = [];
  for (const q of Q.values()) {
    const inst = getInstrument(q.token);
    const vol = (inst.segment === 'IDX' ? 0.00035 : 0.0006) * (open ? 1 : 0.3);
    const pull = ((q.base - q.ltp) / q.base) * 0.02;
    let next = q.ltp * (1 + pull + vol * gauss());
    if (q.upper) next = Math.min(q.upper, Math.max(q.lower, next));
    next = roundTick(next, Number(inst.tick) || 0.05);
    if (next === q.ltp) continue;
    if (q.volume === 0 && open) q.open = next;
    q.ltp = next; q.high = Math.max(q.high, next); q.low = Math.min(q.low, next);
    q.volume += Math.round(Math.random() * 5000); q.ts = Date.now();
    moved.push(q.token);
  }
  if (moved.length) bus.emit('ticks', moved);
}

// Optional: real delayed prices from Yahoo Finance (free) as the reference level
async function pollYahoo() {
  for (const [token, y] of Object.entries(yahooMap())) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=1d&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const m = (await r.json()).chart.result[0].meta;
      const q = Q.get(token);
      if (q && m.regularMarketPrice) { q.base = m.regularMarketPrice; if (!isOpen()) q.ltp = m.regularMarketPrice; }
    } catch { /* keep previous */ }
  }
}

const yahooMap = () => Object.fromEntries([...universe.indices.map((i) => [`IDX:${i.symbol}`, i.yahoo]), ...universe.stocks.map((s) => [`NSE:${s.symbol}`, `${s.symbol}.NS`])]);
// Replace seeded candles with ~2 years of real daily history (Yahoo Finance, delayed)
async function loadYahooHistory() {
  let ok = 0;
  for (const [token, y] of Object.entries(yahooMap())) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=2y&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const d = (await r.json()).chart.result[0];
      const q = d.indicators.quote[0];
      const rows = [];
      d.timestamp.forEach((t, i) => {
        if ([q.open[i], q.high[i], q.low[i], q.close[i]].some((v) => v == null)) return;
        rows.push([istParts(new Date(t * 1000)).date, r2(q.open[i]), r2(q.high[i]), r2(q.low[i]), r2(q.close[i]), Math.round(q.volume[i] || 0)]);
      });
      const today = istParts().date;
      const hist = rows.filter((x) => x[0] < today);
      if (hist.length < 50) continue;
      await db.query('delete from candles where token=$1', [token]);
      for (let k = 0; k < hist.length; k += 200) {
        const chunk = hist.slice(k, k + 200);
        const vals = chunk.map((_, i) => `($1,$${i * 6 + 2},$${i * 6 + 3},$${i * 6 + 4},$${i * 6 + 5},$${i * 6 + 6},$${i * 6 + 7})`).join(',');
        await db.query(`insert into candles(token, day, open, high, low, close, volume) values ${vals} on conflict do nothing`, [token, ...chunk.flat()]);
      }
      const prev = hist.at(-1)[4];
      const qq = Q.get(token);
      const inst = getInstrument(token);
      if (qq) Object.assign(qq, { close: prev, ltp: d.meta.regularMarketPrice || prev, base: d.meta.regularMarketPrice || prev, open: prev, high: Math.max(prev, d.meta.regularMarketPrice || prev), low: Math.min(prev, d.meta.regularMarketPrice || prev) }, band(inst, prev));
      ok++;
    } catch (e) { if (!ok) console.warn('yahoo', token, e.message); }
  }
  console.log(`Yahoo history loaded for ${ok} instruments`);
}

// Background: swap simulated history/prices for real delayed data when FEED_ADAPTER=yahoo
export async function loadRealData() {
  if (config.feedAdapter !== 'yahoo') return;
  await loadYahooHistory().catch((e) => console.warn('yahoo history', e.message));
  await pollYahoo().catch((e) => console.warn('yahoo feed', e.message));
}

export function startFeed() {
  stopFeed();
  timer = setInterval(step, config.tickMs);
  if (config.feedAdapter === 'yahoo') setInterval(() => pollYahoo().catch(() => {}), 60_000).unref();
}
export function stopFeed() { if (timer) clearInterval(timer); timer = null; }

// ── Quotes
export const spotOf = (token) => Q.get(token)?.ltp || 0;
export const spotForUnderlying = (u) => spotOf(DERIV[u]?.spot);

export function quote(token, now = new Date()) {
  const inst = getInstrument(token);
  if (!inst) return null;
  if (inst.segment !== 'FO') {
    const q = Q.get(token);
    if (!q) return null;
    const change = q.ltp - q.close;
    return { ...q, base: undefined, symbol: inst.symbol, name: inst.name, change: r2(change), pct: r2((change / q.close) * 100), bid: r2(q.ltp - 0.05), ask: r2(q.ltp + 0.05) };
  }
  const spotQ = Q.get(DERIV[inst.underlying].spot);
  if (!spotQ) return null;
  const T = yearsTo(inst.expiry, now);
  let ltp, prev;
  if (inst.type === 'FUT') {
    ltp = roundTick(spotQ.ltp * Math.exp(0.065 * T));
    prev = roundTick(spotQ.close * Math.exp(0.065 * (T + 1 / 365)));
  } else {
    ltp = roundTick(optionPremium({ spot: spotQ.ltp, strike: Number(inst.strike), type: inst.type, expiry: inst.expiry, now }));
    prev = roundTick(optionPremium({ spot: spotQ.close, strike: Number(inst.strike), type: inst.type, expiry: inst.expiry, now: new Date(now.getTime() - 86400000) }));
  }
  ltp = Math.max(0.05, ltp);
  return { token, symbol: inst.symbol, name: inst.name, ltp, close: prev, open: prev, high: Math.max(ltp, prev), low: Math.min(ltp, prev), volume: 0, change: r2(ltp - prev), pct: prev ? r2(((ltp - prev) / prev) * 100) : 0, bid: r2(Math.max(0.05, ltp - 0.05)), ask: r2(ltp + 0.05), upper: null, lower: null, ts: spotQ.ts };
}
export const ltpOf = (token) => quote(token)?.ltp || 0;

export async function candles(token, days = 400) {
  const rows = await db.query('select day as time, open, high, low, close, volume from candles where token=$1 order by day desc limit $2', [token, days]);
  rows.reverse();
  const q = Q.get(token);
  const today = istParts().date;
  if (q && (!rows.length || rows.at(-1).time < today) && q.volume > 0) rows.push({ time: today, open: q.open, high: q.high, low: q.low, close: q.ltp, volume: q.volume });
  else if (q && rows.length && rows.at(-1).time === today) Object.assign(rows.at(-1), { close: q.ltp, high: Math.max(rows.at(-1).high, q.ltp), low: Math.min(rows.at(-1).low, q.ltp) });
  return rows;
}

// EOD: write today's candle, roll prev close, reset day stats and circuit bands
export async function closeDay(date = istParts().date) {
  for (const q of Q.values()) {
    if (q.volume > 0) {
      await db.query(`insert into candles(token, day, open, high, low, close, volume) values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (token, day) do update set open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`,
      [q.token, date, q.open, q.high, q.low, q.ltp, q.volume]);
    }
    const inst = getInstrument(q.token);
    Object.assign(q, { close: q.ltp, open: q.ltp, high: q.ltp, low: q.ltp, volume: 0, base: q.base }, band(inst, q.ltp));
  }
}

// For tests / admin: force a price
export function setPrice(token, price) {
  const q = Q.get(token); if (!q) return false;
  q.ltp = price; q.base = price; q.high = Math.max(q.high, price); q.low = Math.min(q.low, price); q.volume += 1; q.ts = Date.now();
  bus.emit('ticks', [token]);
  return true;
}
export { parseToken };
