// Statutory + brokerage charges (approximate published rates; configurable via `rates`)
import { r2, isOption, isDerivative } from './util.js';

export const DEFAULT_RATES = {
  brokerage: { CNC: 0, MIS: { pct: 0.0003, max: 20 }, NRML_FUT: { pct: 0.0003, max: 20 }, OPT: 20 },
  stt: { CNC: 0.001, MIS_SELL: 0.00025, FUT_SELL: 0.0002, OPT_SELL: 0.001 },
  exchange: { EQ: 0.0000297, FUT: 0.0000173, OPT: 0.0003503 },
  sebiPerCrore: 10,
  stamp: { CNC: 0.00015, MIS: 0.00003, FUT: 0.00002, OPT: 0.00003 },
  gst: 0.18, dpPerScrip: 15.93,
};

export function calcCharges({ side, product, qty, price, token }, rates = DEFAULT_RATES) {
  const v = qty * price;
  const opt = isOption(token), fut = isDerivative(token) && !opt;
  let brokerage = 0, stt = 0, exch = 0, stamp = 0, dp = 0;
  if (opt) {
    brokerage = rates.brokerage.OPT; stt = side === 'SELL' ? v * rates.stt.OPT_SELL : 0;
    exch = v * rates.exchange.OPT; stamp = side === 'BUY' ? v * rates.stamp.OPT : 0;
  } else if (fut) {
    brokerage = Math.min(rates.brokerage.NRML_FUT.max, v * rates.brokerage.NRML_FUT.pct);
    stt = side === 'SELL' ? v * rates.stt.FUT_SELL : 0; exch = v * rates.exchange.FUT; stamp = side === 'BUY' ? v * rates.stamp.FUT : 0;
  } else if (product === 'CNC') {
    brokerage = rates.brokerage.CNC; stt = v * rates.stt.CNC; exch = v * rates.exchange.EQ;
    stamp = side === 'BUY' ? v * rates.stamp.CNC : 0; dp = side === 'SELL' ? rates.dpPerScrip : 0;
  } else {
    brokerage = Math.min(rates.brokerage.MIS.max, v * rates.brokerage.MIS.pct);
    stt = side === 'SELL' ? v * rates.stt.MIS_SELL : 0; exch = v * rates.exchange.EQ; stamp = side === 'BUY' ? v * rates.stamp.MIS : 0;
  }
  const sebi = (v / 1e7) * rates.sebiPerCrore;
  const gst = (brokerage + exch + sebi) * rates.gst;
  const total = brokerage + stt + exch + stamp + sebi + gst + dp;
  return { brokerage: r2(brokerage), stt: r2(stt), exchange: r2(exch), sebi: r2(sebi), stamp: r2(stamp), gst: r2(gst), dp: r2(dp), total: r2(total) };
}
