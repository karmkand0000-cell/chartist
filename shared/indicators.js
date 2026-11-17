// Technical indicators. Input: array of numbers (closes). Output: arrays aligned to input (null where undefined)
export function sma(v, n) {
  const out = Array(v.length).fill(null);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= n) sum -= v[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(v, n) {
  const out = Array(v.length).fill(null);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let prev = v.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

export function rsi(v, n = 14) {
  const out = Array(v.length).fill(null);
  if (v.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(v, fast = 12, slow = 26, sig = 9) {
  const ef = ema(v, fast), es = ema(v, slow);
  const line = v.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const start = line.findIndex((x) => x != null);
  const signal = Array(v.length).fill(null);
  if (start >= 0) {
    const s = ema(line.slice(start), sig);
    s.forEach((x, i) => (signal[start + i] = x));
  }
  const hist = line.map((x, i) => (x != null && signal[i] != null ? x - signal[i] : null));
  return { line, signal, hist };
}

export function bollinger(v, n = 20, k = 2) {
  const mid = sma(v, n);
  const upper = Array(v.length).fill(null), lower = Array(v.length).fill(null);
  for (let i = n - 1; i < v.length; i++) {
    const slice = v.slice(i - n + 1, i + 1);
    const sd = Math.sqrt(slice.reduce((a, x) => a + (x - mid[i]) ** 2, 0) / n);
    upper[i] = mid[i] + k * sd; lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

// Simple trend summary used on the stock page
export function technicalSummary(closes) {
  const last = closes.at(-1);
  const s20 = sma(closes, 20).at(-1), s50 = sma(closes, 50).at(-1), s200 = sma(closes, 200).at(-1);
  const r = rsi(closes).at(-1);
  const m = macd(closes);
  let score = 0;
  const signals = [];
  const add = (cond, label) => { if (cond == null) return; score += cond ? 1 : -1; signals.push({ label, bullish: !!cond }); };
  add(s20 != null ? last > s20 : null, 'Price vs 20-DMA');
  add(s50 != null ? last > s50 : null, 'Price vs 50-DMA');
  add(s200 != null ? last > s200 : null, 'Price vs 200-DMA');
  add(m.hist.at(-1) != null ? m.hist.at(-1) > 0 : null, 'MACD histogram');
  if (r != null) signals.push({ label: `RSI(14) ${r.toFixed(1)}`, bullish: r > 50, note: r > 70 ? 'Overbought' : r < 30 ? 'Oversold' : 'Neutral' });
  const verdict = score >= 3 ? 'Strong bullish' : score >= 1 ? 'Bullish' : score <= -3 ? 'Strong bearish' : score <= -1 ? 'Bearish' : 'Neutral';
  return { verdict, score, signals, rsi: r, sma20: s20, sma50: s50, sma200: s200 };
}
