// Mutual fund distribution: schemes (AMFI NAVs via mfapi.in or demo), lumpsum, SIP, redemption
import { db } from '../db.js';
import { bad, notFound } from '../errors.js';
import { post, margins } from './funds.js';
import { audit, notify } from './audit.js';
import { universe } from './instruments.js';
import { r2, istParts } from '../../../shared/util.js';

const MF_FEED = process.env.MF_FEED || 'demo';

async function fetchJson(url) { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }

async function loadFromMfapi() {
  let n = 0;
  for (const spec of universe.mutual_funds || []) {
    try {
      let pick = null;
      for (const q of spec.q) {
        const res = await fetchJson(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`);
        pick = res.find((r) => /direct/i.test(r.schemeName) && /growth/i.test(r.schemeName) && !/idcw|bonus/i.test(r.schemeName));
        if (pick) break;
      }
      if (!pick) continue;
      const d = await fetchJson(`https://api.mfapi.in/mf/${pick.schemeCode}`);
      const navs = d.data.map((x) => [x.date.split('-').reverse().join('-'), Number(x.nav)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const cutoff = new Date(Date.now() - 6 * 365 * 864e5).toISOString().slice(0, 10);
      const hist = []; let wk = '';
      for (const [day, nav] of navs) { if (day < cutoff) continue; const w = day.slice(0, 8) + String(Math.floor(+day.slice(8) / 7)); if (w !== wk) { hist.push([day, nav]); wk = w; } }
      const last = navs.at(-1);
      await db.query(`insert into mf_schemes(code, name, house, category, nav, nav_date, history, source) values ($1,$2,$3,$4,$5,$6,$7,'amfi')
        on conflict (code) do update set nav=excluded.nav, nav_date=excluded.nav_date, history=excluded.history, name=excluded.name, source='amfi'`,
      [String(pick.schemeCode), d.meta.scheme_name, d.meta.fund_house, spec.category, last[1], last[0], JSON.stringify(hist)]);
      n++;
    } catch (e) { console.warn('mfapi', spec.q[0], e.message); }
  }
  return n;
}

function seedDemo() {
  const list = [['DEMO1', 'Demo Flexi Cap Fund', 'Flexi Cap', 0.15, 0.025], ['DEMO2', 'Demo Small Cap Fund', 'Small Cap', 0.2, 0.035], ['DEMO3', 'Demo Nifty 50 Index Fund', 'Index Fund', 0.12, 0.02], ['DEMO4', 'Demo ELSS Tax Saver Fund', 'ELSS', 0.14, 0.025], ['DEMO5', 'Demo Liquid Fund', 'Debt - Liquid', 0.068, 0.001]];
  return list.map(([code, name, cat, cagr, vol]) => {
    let nav = 10; const hist = []; const d = new Date(Date.now() - 6 * 365 * 864e5);
    while (d < new Date()) { hist.push([d.toISOString().slice(0, 10), +nav.toFixed(4)]); nav *= Math.exp(Math.log(1 + cagr) / 52 + (Math.random() - 0.5) * 2 * vol); d.setDate(d.getDate() + 7); }
    return { code, name, cat, hist };
  });
}

export async function initMf() {
  const have = (await db.one('select count(*)::int n from mf_schemes')).n;
  if (have) return;
  for (const f of seedDemo()) {
    const last = f.hist.at(-1);
    await db.query(`insert into mf_schemes(code, name, house, category, nav, nav_date, history) values ($1,$2,'Demo AMC',$3,$4,$5,$6) on conflict do nothing`, [f.code, f.name, f.cat, last[1], last[0], JSON.stringify(f.hist)]);
  }
}
export async function refreshNavs() {
  if (MF_FEED !== 'mfapi') return 0;
  const n = await loadFromMfapi();
  if (n) await db.query(`update mf_schemes set active = (source = 'amfi')`);
  console.log(`AMFI NAVs loaded for ${n} schemes`);
  return n;
}

function cagr(hist, years) {
  if (!hist?.length) return null;
  const last = hist.at(-1); const t = new Date(last[0]); t.setFullYear(t.getFullYear() - years);
  const s = hist.find((h) => h[0] >= t.toISOString().slice(0, 10));
  if (!s || (new Date(s[0]) - t) > 40 * 864e5) return null;
  return r2((Math.pow(last[1] / s[1], 1 / years) - 1) * 100);
}
export async function schemes() {
  const rows = await db.query('select * from mf_schemes where active order by category, name');
  return rows.map((s) => ({ ...s, history: s.history.slice(-60), r1: cagr(s.history, 1), r3: cagr(s.history, 3), r5: cagr(s.history, 5) }));
}

async function buy(t, userId, s, amount, sipId = null) {
  const units = Math.floor((amount / s.nav) * 10000) / 10000;
  await post(t, userId, 'MF_BUY', { debit: amount, ref: `MF-${s.code}`, narration: `${sipId ? 'SIP' : 'Lumpsum'}: ${s.name} @ NAV ${s.nav}` });
  await t.query(`insert into mf_holdings(user_id, code, units, invested) values ($1,$2,$3,$4)
    on conflict (user_id, code) do update set units = mf_holdings.units + $3, invested = mf_holdings.invested + $4`, [userId, s.code, units, amount]);
  return t.one(`insert into mf_orders(user_id, code, side, amount, units, nav, sip_id) values ($1,$2,'BUY',$3,$4,$5,$6) returning *`, [userId, s.code, amount, units, s.nav, sipId]);
}

export async function invest(user, { code, amount }) {
  if (user.status !== 'active') throw bad('Account not active');
  amount = r2(Number(amount));
  const s = await db.one('select * from mf_schemes where code=$1 and active', [code]); if (!s) throw notFound('Scheme not found');
  if (!(amount >= s.min_lump)) throw bad(`Minimum investment is ₹${s.min_lump}`);
  return db.tx(async (t) => {
    if ((await margins(user.id, t)).available < amount) throw bad('Insufficient funds');
    const o = await buy(t, user.id, s, amount);
    await audit(user, 'mf_buy', 'mf_order', o.id, { code, amount }, null, t);
    return o;
  });
}

export async function redeem(user, { code, units, all }) {
  return db.tx(async (t) => {
    const h = await t.one('select * from mf_holdings where user_id=$1 and code=$2 for update', [user.id, code]);
    if (!h || h.units <= 0) throw bad('No units to redeem');
    const s = await t.one('select * from mf_schemes where code=$1', [code]);
    const u = all ? h.units : Math.min(h.units, Number(units));
    if (!(u > 0)) throw bad('Enter units to redeem');
    const amount = r2(u * s.nav);
    const costFrac = u / h.units;
    await t.query('update mf_holdings set units = units - $3, invested = invested * (1 - $4) where user_id=$1 and code=$2', [user.id, code, u, costFrac]);
    await post(t, user.id, 'MF_REDEEM', { credit: amount, ref: `MF-${code}`, narration: `Redeemed ${u} units of ${s.name} @ NAV ${s.nav}` });
    const o = await t.one(`insert into mf_orders(user_id, code, side, amount, units, nav) values ($1,$2,'REDEEM',$3,$4,$5) returning *`, [user.id, code, amount, u, s.nav]);
    await audit(user, 'mf_redeem', 'mf_order', o.id, { code, units: u }, null, t);
    return o;
  });
}

function nextDate(day, from = istParts().date) {
  const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(day);
  if (d.toISOString().slice(0, 10) < from) d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
export async function startSip(user, { code, amount, day, firstToday }) {
  amount = r2(Number(amount)); day = Math.min(28, Math.max(1, Number(day) || 5));
  const s = await db.one('select * from mf_schemes where code=$1 and active', [code]); if (!s) throw notFound();
  if (!(amount >= s.min_sip)) throw bad(`Minimum SIP is ₹${s.min_sip}`);
  const sip = await db.one('insert into sips(user_id, code, amount, day, next_date) values ($1,$2,$3,$4,$5) returning *', [user.id, code, amount, day, firstToday ? istParts().date : nextDate(day)]);
  await audit(user, 'sip_started', 'sip', sip.id, { code, amount, day });
  await processSips();
  return db.one('select * from sips where id=$1', [sip.id]);
}
export async function cancelSip(user, id) {
  const r = await db.one(`update sips set status='CANCELLED' where id=$1 and user_id=$2 and status='ACTIVE' returning id`, [id, user.id]);
  if (!r) throw bad('SIP not active');
}
export async function processSips() {
  const today = istParts().date;
  let done = 0;
  for (const sip of await db.query(`select * from sips where status='ACTIVE' and next_date <= $1`, [today])) {
    const s = await db.one('select * from mf_schemes where code=$1', [sip.code]);
    try {
      await db.tx(async (t) => {
        if ((await margins(sip.user_id, t)).available < sip.amount) throw new Error('Insufficient funds');
        await buy(t, sip.user_id, s, sip.amount, sip.id);
        const n = new Date(`${sip.next_date}T00:00:00Z`); n.setUTCMonth(n.getUTCMonth() + 1);
        await t.query('update sips set installments = installments + 1, next_date=$2 where id=$1', [sip.id, n.toISOString().slice(0, 10)]);
      });
      done++;
    } catch (e) {
      const n = new Date(`${sip.next_date}T00:00:00Z`); n.setUTCMonth(n.getUTCMonth() + 1);
      await db.query('update sips set next_date=$2 where id=$1', [sip.id, n.toISOString().slice(0, 10)]);
      await notify(sip.user_id, 'SIP instalment failed', `${s.name}: ${e.message}. Next attempt on ${n.toISOString().slice(0, 10)}.`);
    }
  }
  return done;
}

export async function portfolio(userId) {
  const holdings = await db.query('select h.*, s.name, s.nav, s.nav_date, s.category from mf_holdings h join mf_schemes s on s.code=h.code where h.user_id=$1 and h.units > 0', [userId]);
  return {
    holdings: holdings.map((h) => ({ ...h, current: r2(h.units * h.nav), pnl: r2(h.units * h.nav - h.invested) })),
    sips: await db.query(`select p.*, s.name from sips p join mf_schemes s on s.code=p.code where p.user_id=$1 and p.status='ACTIVE' order by p.id`, [userId]),
    orders: await db.query('select o.*, s.name from mf_orders o join mf_schemes s on s.code=o.code where o.user_id=$1 order by o.id desc limit 50', [userId]),
  };
}
