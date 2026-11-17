// Shared helpers (used by server and browser)
export const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const roundTick = (p, tick = 0.05) => r2(Math.round(Number(p) / tick) * tick);

export function istParts(now = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${hh}:${p.minute}`, hms: `${hh}:${p.minute}:${p.second}`, weekday: p.weekday };
}
export const isWeekday = (now = new Date()) => !['Sat', 'Sun'].includes(istParts(now).weekday);

// Instrument tokens:  NSE:RELIANCE · IDX:NIFTY50 · NFO:NIFTY:2026-11-24:26000:CE · NFO:NIFTY:2026-11-25:FUT
export function parseToken(token) {
  const p = String(token).split(':');
  if (p[0] === 'NFO') {
    if (p[3] === 'FUT') return { exchange: 'NFO', underlying: p[1], expiry: p[2], type: 'FUT', strike: null };
    return { exchange: 'NFO', underlying: p[1], expiry: p[2], strike: Number(p[3]), type: p[4] };
  }
  return { exchange: p[0], symbol: p[1], type: p[0] === 'IDX' ? 'INDEX' : 'EQ' };
}
export const isDerivative = (token) => String(token).startsWith('NFO:');
export const isOption = (token) => isDerivative(token) && !String(token).endsWith(':FUT');
export function displayName(token) {
  const t = parseToken(token);
  if (t.exchange !== 'NFO') return t.symbol;
  const d = new Date(`${t.expiry}T00:00:00Z`);
  const m = `${String(d.getUTCDate()).padStart(2, '0')} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()}`;
  return t.type === 'FUT' ? `${t.underlying} ${m} FUT` : `${t.underlying} ${m} ${t.strike} ${t.type}`;
}
