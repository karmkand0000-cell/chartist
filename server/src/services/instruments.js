// Instrument master: equities, indices and rolling NIFTY/BANKNIFTY derivatives
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { getSetting } from './settings.js';
import { weeklyExpiries, monthlyExpiries } from '../../../shared/options.js';
import { displayName } from '../../../shared/util.js';

const U = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../db/universe.json'), 'utf8'));
export const DERIV = {
  NIFTY: { spot: 'IDX:NIFTY50', step: 50, strikes: 15, freeze: 1800, weekly: true },
  BANKNIFTY: { spot: 'IDX:BANKNIFTY', step: 100, strikes: 15, freeze: 900, weekly: false },
};
const cache = new Map();

export async function seedInstruments() {
  for (const i of U.indices) {
    await db.query(`insert into instruments(token, symbol, name, exchange, segment, type, lot, tick, base_price) values ($1,$2,$3,'IDX','IDX','INDEX',1,0.05,$4)
      on conflict (token) do nothing`, [`IDX:${i.symbol}`, i.symbol, i.name, i.demo]);
  }
  for (const s of U.stocks) {
    await db.query(`insert into instruments(token, symbol, name, exchange, segment, type, lot, tick, band_pct, sector, base_price, freeze_qty) values ($1,$2,$3,'NSE','EQ','EQ',1,0.05,20,$4,$5,100000)
      on conflict (token) do nothing`, [`NSE:${s.symbol}`, s.symbol, s.name, s.sector, s.demo]);
  }
  await loadCache();
}

// Create derivative contracts for upcoming expiries around the current spot
export async function rollDerivatives(spotOf, now = new Date()) {
  const lots = getSetting('lots');
  let created = 0;
  for (const [u, d] of Object.entries(DERIV)) {
    const spot = spotOf(d.spot);
    if (!spot) continue;
    const exps = d.weekly ? weeklyExpiries(3, 2, now) : monthlyExpiries(2, 2, now);
    const futs = monthlyExpiries(2, 2, now);
    const atm = Math.round(spot / d.step) * d.step;
    for (const e of exps) {
      for (let i = -d.strikes; i <= d.strikes; i++) {
        const k = atm + i * d.step;
        for (const t of ['CE', 'PE']) {
          const token = `NFO:${u}:${e}:${k}:${t}`;
          if (cache.has(token)) continue;
          await db.query(`insert into instruments(token, symbol, name, exchange, segment, type, underlying, strike, expiry, lot, tick, freeze_qty)
            values ($1,$2,$3,'NFO','FO',$4,$5,$6,$7,$8,0.05,$9) on conflict (token) do nothing`, [token, displayName(token), displayName(token), t, u, k, e, lots[u], d.freeze]);
          created++;
        }
      }
    }
    for (const e of futs) {
      const token = `NFO:${u}:${e}:FUT`;
      if (cache.has(token)) continue;
      await db.query(`insert into instruments(token, symbol, name, exchange, segment, type, underlying, expiry, lot, tick, freeze_qty)
        values ($1,$2,$3,'NFO','FO','FUT',$4,$5,$6,0.05,$7) on conflict (token) do nothing`, [token, displayName(token), displayName(token), u, e, lots[u], d.freeze]);
      created++;
    }
  }
  // Deactivate expired contracts
  await db.query(`update instruments set active = false where segment = 'FO' and expiry < (now() at time zone 'Asia/Kolkata')::date and active`);
  await loadCache();
  return created;
}

export async function loadCache() {
  cache.clear();
  for (const r of await db.query('select * from instruments')) cache.set(r.token, r);
}
export const getInstrument = (token) => cache.get(token) || null;
export const allInstruments = () => [...cache.values()];
export const equities = () => allInstruments().filter((i) => i.segment === 'EQ' && i.active);
export const indices = () => allInstruments().filter((i) => i.segment === 'IDX');
export function searchInstruments(q, limit = 20) {
  q = String(q || '').trim().toUpperCase();
  if (!q) return [];
  return allInstruments().filter((i) => i.active && (i.symbol.toUpperCase().includes(q) || i.name.toUpperCase().includes(q)))
    .sort((a, b) => (a.segment === 'FO') - (b.segment === 'FO') || (b.symbol.startsWith(q) - a.symbol.startsWith(q)))
    .slice(0, limit);
}
export function expiriesFor(u) {
  return [...new Set(allInstruments().filter((i) => i.underlying === u && i.active && i.type !== 'FUT').map((i) => i.expiry))].sort();
}
export const universe = U;
