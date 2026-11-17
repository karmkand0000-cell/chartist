import { db } from '../db.js';
import { config } from '../config.js';
const cache = new Map();
export const DEFAULTS = {
  kill_switch: false,                // blocks all new orders platform-wide
  market_mode: config.marketMode,    // auto | open | closed (env MARKET_MODE sets the default)
  square_off_time: '15:20',
  allow_amo: true,
  fno_enabled: true,
  lots: { NIFTY: 75, BANKNIFTY: 35 },
  margin: { misRate: 0.2, futRate: 0.12, optShortRate: 0.12 },
  mtm_square_off_pct: 80,            // auto square-off when MTM loss reaches this % of margin used
};
export async function loadSettings() {
  for (const r of await db.query('select key, value from settings')) cache.set(r.key, r.value);
}
export const getSetting = (k) => (cache.has(k) ? cache.get(k) : DEFAULTS[k]);
export async function setSetting(k, v) {
  await db.query('insert into settings(key, value) values ($1,$2) on conflict (key) do update set value = excluded.value', [k, JSON.stringify(v)]);
  cache.set(k, v);
}
export const allSettings = () => Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, getSetting(k)]));
