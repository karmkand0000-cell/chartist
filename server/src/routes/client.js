// Client-facing REST API (/api/...)
import { db } from '../db.js';
import { bad, notFound } from '../errors.js';
import { authenticate } from '../auth-hook.js';
import * as A from '../services/auth.js';
import * as K from '../services/kyc.js';
import * as F from '../services/funds.js';
import * as P from '../services/portfolio.js';
import * as O from '../services/oms.js';
import * as R from '../services/reports.js';
import * as M from '../services/market.js';
import * as I from '../services/instruments.js';
import { getSetting } from '../services/settings.js';
import { config } from '../config.js';
import { chainFor } from './chain.js';
import * as MF from '../services/mf.js';
import * as IPO from '../services/ipo.js';
import { displayName } from '../../../shared/util.js';

export default async function clientRoutes(app) {
  const ip = (req) => req.ip;
  const authed = { preHandler: authenticate };

  // ── Public
  app.get('/api/health', async () => ({ ok: true, db: (await db.one('select 1 as x')).x === 1, exchange: O.exchangeName(), market: M.marketStatus(), time: new Date().toISOString() }));
  app.get('/api/meta', async () => ({ demo: config.demoSeed && config.showOtp ? { email: 'demo@chartist.in', password: 'Demo@1234' } : null, broker: config.brokerName, sebiReg: config.sebiReg, market: M.marketStatus(), exchange: O.exchangeName(), simulator: O.exchangeName() === 'SIMULATOR', killSwitch: getSetting('kill_switch'), squareOffTime: getSetting('square_off_time') }));
  app.get('/api/instruments/search', async (req) => I.searchInstruments(req.query.q, 25).map((i) => ({ token: i.token, symbol: i.symbol, name: i.name, segment: i.segment, exchange: i.exchange, lot: i.lot, ltp: M.ltpOf(i.token) })));
  app.get('/api/instruments/:token', async (req) => { const i = I.getInstrument(req.params.token); if (!i) throw notFound(); return { ...i, quote: M.quote(i.token) }; });
  app.get('/api/market/overview', async () => {
    const eq = I.equities().map((i) => ({ ...M.quote(i.token), sector: i.sector })).filter((q) => q.ltp);
    const byPct = [...eq].sort((a, b) => b.pct - a.pct);
    return { status: M.marketStatus(), indices: I.indices().map((i) => M.quote(i.token)), gainers: byPct.slice(0, 8), losers: byPct.slice(-8).reverse(), active: [...eq].sort((a, b) => b.volume * b.ltp - a.volume * a.ltp).slice(0, 8), all: eq };
  });
  app.post('/api/quotes', async (req) => Object.fromEntries((req.body?.tokens || []).slice(0, 200).map((t) => [t, M.quote(t)])));
  app.get('/api/candles/:token', async (req) => M.candles(req.params.token, Math.min(1500, Number(req.query.days) || 400)));
  app.get('/api/optionchain/:underlying', async (req) => chainFor(req.params.underlying, req.query.expiry));

  // ── Auth
  app.post('/api/auth/signup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => A.signup(req.body || {}, ip(req)));
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => A.login(req.body || {}, ip(req)));
  app.post('/api/auth/mfa', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => A.completeMfa({ ...req.body, device: req.headers['user-agent']?.slice(0, 120) }, ip(req)));
  app.post('/api/auth/refresh', async (req) => A.refresh(req.body?.refreshToken));
  app.post('/api/auth/forgot', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => ({ ok: true, ...(await A.forgotPassword(req.body?.login)) }));
  app.post('/api/auth/reset', async (req) => { await A.resetPassword(req.body || {}); return { ok: true }; });
  app.post('/api/auth/logout', authed, async (req) => { await A.logout(req.user); return { ok: true }; });
  app.post('/api/auth/logout-all', authed, async (req) => { await A.logoutAll(req.user); return { ok: true }; });
  app.get('/api/auth/sessions', authed, async (req) => A.listSessions(req.user));
  app.get('/api/me', authed, async (req) => ({ user: A.publicUser(req.user) }));
  app.post('/api/me/verify', authed, async (req) => { await A.verifyContact(req.user, req.body?.kind, req.body?.code); return { ok: true }; });
  app.post('/api/me/resend-otp', authed, async (req) => ({ ok: true, devOtp: await A.resendOtp(req.user, req.body?.kind) }));
  app.post('/api/me/totp/setup', authed, async (req) => A.totpSetup(req.user));
  app.post('/api/me/totp/enable', authed, async (req) => { await A.totpEnable(req.user, req.body?.code); return { ok: true }; });
  app.post('/api/me/password', authed, async (req) => { await A.changePassword(req.user, req.body || {}); return { ok: true }; });

  // ── KYC
  app.get('/api/kyc', authed, async (req) => K.getKyc(req.user.id));
  app.post('/api/kyc/step/:step', authed, async (req) => { await K.reopenIfRejected(req.user); return K.saveStep(req.user, req.params.step, req.body || {}); });
  app.post('/api/kyc/documents', { ...authed, bodyLimit: 4 * 1024 * 1024 }, async (req) => { await K.reopenIfRejected(req.user); return K.uploadDocument(req.user, req.body || {}); });
  app.post('/api/kyc/submit', authed, async (req) => { await K.submit(req.user); return { ok: true }; });

  // ── Funds
  app.get('/api/funds', authed, async (req) => F.margins(req.user.id));
  app.get('/api/funds/requests', authed, async (req) => db.query('select * from fund_requests where user_id=$1 order by id desc limit 100', [req.user.id]));
  app.post('/api/funds/payin', authed, async (req) => F.requestPayin(req.user, req.body || {}));
  app.post('/api/funds/payout', authed, async (req) => F.requestPayout(req.user, req.body || {}));
  app.delete('/api/funds/requests/:id', authed, async (req) => { await F.cancelRequest(req.user, Number(req.params.id)); return { ok: true }; });
  app.get('/api/funds/bank', authed, async (req) => { const k = await K.getKyc(req.user.id); return k?.bank || {}; });

  // ── Orders
  app.get('/api/orders', authed, async (req) => (await db.query(`select * from orders where user_id=$1 and (trade_date >= (now() at time zone 'Asia/Kolkata')::date - 7 or status in ('OPEN','TRIGGER_PENDING','AMO_REQ_RECEIVED')) order by id desc limit 500`, [req.user.id])).map(O.decorate));
  app.get('/api/orders/:id', authed, async (req) => {
    const o = await db.one('select * from orders where id=$1 and user_id=$2', [req.params.id, req.user.id]); if (!o) throw notFound();
    return { ...O.decorate(o), events: await db.query('select * from order_events where order_id=$1 order by id', [o.id]), trades: await db.query('select * from trades where order_id=$1 order by id', [o.id]) };
  });
  app.post('/api/orders', { ...authed, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => O.placeOrder(req.user, req.body || {}, { ip: ip(req) }));
  app.post('/api/orders/basket', authed, async (req) => {
    const list = (req.body?.orders || []).slice(0, 20);
    // Hedge first: buys before sells so spread margin benefit applies
    list.sort((a, b) => (a.side === 'BUY' ? -1 : 1) - (b.side === 'BUY' ? -1 : 1));
    const out = [];
    for (const o of list) { try { out.push({ ok: true, order: await O.placeOrder(req.user, o, { ip: ip(req) }) }); } catch (e) { out.push({ ok: false, error: e.message }); } }
    return out;
  });
  app.post('/api/orders/margin', authed, async (req) => {
    const o = req.body || {};
    const q = M.quote(o.token); if (!q) throw bad('Unknown instrument');
    const { calcCharges } = await import('../../../shared/charges.js');
    const px = Number(o.price) || q.ltp;
    let required = null, error = null;
    try { required = await db.tx(async (t) => (await import('../services/rms.js')).preTrade(t, { ...req.user, status: 'active' }, { ...o, qty: Number(o.qty), price: o.price ? Number(o.price) : null, trigger_price: o.trigger_price ? Number(o.trigger_price) : null, variety: M.isOpen() ? 'REGULAR' : 'AMO', order_type: o.order_type || 'MARKET', product: o.product || 'CNC' })); } catch (e) { error = e.message; }
    return { required, error, charges: calcCharges({ side: o.side, product: o.product, qty: Number(o.qty) || 0, price: px, token: o.token }), funds: await F.margins(req.user.id) };
  });
  app.patch('/api/orders/:id', authed, async (req) => O.modifyOrder(req.user, Number(req.params.id), req.body || {}, ip(req)));
  app.delete('/api/orders/:id', authed, async (req) => O.cancelOrder(req.user, Number(req.params.id), ip(req)));

  // ── Portfolio
  app.get('/api/positions', authed, async (req) => P.positions(req.user.id));
  app.post('/api/positions/exit', authed, async (req) => {
    const { token, product } = req.body || {};
    const p = await db.one('select * from positions where user_id=$1 and token=$2 and product=$3 and qty <> 0', [req.user.id, token, product]);
    if (!p) throw bad('No open position');
    return O.placeOrder(req.user, { token, product, side: p.qty > 0 ? 'SELL' : 'BUY', qty: Math.abs(p.qty), order_type: 'MARKET', variety: M.isOpen() ? 'REGULAR' : 'AMO', tag: 'EXIT' }, { ip: ip(req) });
  });
  app.get('/api/holdings', authed, async (req) => P.holdings(req.user.id));
  app.get('/api/trades', authed, async (req) => R.tradebook(req.user.id, req.query));

  // ── GTT & alerts
  app.get('/api/gtt', authed, async (req) => (await db.query('select * from gtts where user_id=$1 order by id desc limit 200', [req.user.id])).map((g) => ({ ...g, name: displayName(g.token) })));
  app.post('/api/gtt', authed, async (req) => O.createGtt(req.user, req.body || {}));
  app.delete('/api/gtt/:id', authed, async (req) => { const r = await db.one(`update gtts set status='CANCELLED' where id=$1 and user_id=$2 and status='ACTIVE' returning id`, [req.params.id, req.user.id]); if (!r) throw bad('GTT not active'); return { ok: true }; });
  app.get('/api/alerts', authed, async (req) => (await db.query('select * from alerts where user_id=$1 order by id desc limit 200', [req.user.id])).map((a) => ({ ...a, name: displayName(a.token) })));
  app.post('/api/alerts', authed, async (req) => {
    const { token, direction, price } = req.body || {};
    if (!I.getInstrument(token) || !['above', 'below'].includes(direction) || !(Number(price) > 0)) throw bad('Invalid alert');
    return db.one('insert into alerts(user_id, token, direction, price) values ($1,$2,$3,$4) returning *', [req.user.id, token, direction, Number(price)]);
  });
  app.delete('/api/alerts/:id', authed, async (req) => { await db.query(`update alerts set status='CANCELLED' where id=$1 and user_id=$2`, [req.params.id, req.user.id]); return { ok: true }; });

  // ── Watchlists
  app.get('/api/watchlists', authed, async (req) => db.query('select * from watchlists where user_id=$1 order by position, id', [req.user.id]));
  app.post('/api/watchlists', authed, async (req) => {
    const n = (await db.one('select count(*)::int c from watchlists where user_id=$1', [req.user.id])).c;
    if (n >= 7) throw bad('Maximum 7 watchlists');
    return db.one('insert into watchlists(user_id, name, position) values ($1,$2,$3) returning *', [req.user.id, String(req.body?.name || `Watchlist ${n + 1}`).slice(0, 30), n]);
  });
  app.put('/api/watchlists/:id', authed, async (req) => {
    const tokens = [...new Set((req.body?.tokens || []).filter((t) => I.getInstrument(t)))].slice(0, 100);
    const r = await db.one('update watchlists set tokens=$3, name=coalesce($4, name) where id=$1 and user_id=$2 returning *', [req.params.id, req.user.id, tokens, req.body?.name ? String(req.body.name).slice(0, 30) : null]);
    if (!r) throw notFound(); return r;
  });
  app.delete('/api/watchlists/:id', authed, async (req) => { await db.query('delete from watchlists where id=$1 and user_id=$2', [req.params.id, req.user.id]); return { ok: true }; });

  // ── Reports, notifications, settings
  app.get('/api/reports/ledger', authed, async (req) => R.ledgerStatement(req.user.id, req.query));
  app.get('/api/reports/pnl', authed, async (req) => R.pnl(req.user.id, req.query));
  app.get('/api/reports/contract-notes', authed, async (req) => db.query('select id, trade_date, number, totals from contract_notes where user_id=$1 order by trade_date desc limit 100', [req.user.id]));
  app.get('/api/reports/contract-notes/:id', authed, async (req, reply) => {
    const c = await db.one('select html from contract_notes where id=$1 and user_id=$2', [req.params.id, req.user.id]); if (!c) throw notFound();
    reply.type('text/html').send(c.html);
  });
  app.get('/api/notifications', authed, async (req) => db.query('select * from notifications where (user_id=$1 or user_id is null) order by id desc limit 50', [req.user.id]));
  app.post('/api/notifications/read', authed, async (req) => { await db.query('update notifications set read=true where user_id=$1', [req.user.id]); return { ok: true }; });
  // ── Mutual funds
  app.get('/api/mf/schemes', async () => MF.schemes());
  app.get('/api/mf/portfolio', authed, async (req) => MF.portfolio(req.user.id));
  app.post('/api/mf/invest', authed, async (req) => MF.invest(req.user, req.body || {}));
  app.post('/api/mf/redeem', authed, async (req) => MF.redeem(req.user, req.body || {}));
  app.post('/api/mf/sip', authed, async (req) => MF.startSip(req.user, req.body || {}));
  app.delete('/api/mf/sip/:id', authed, async (req) => { await MF.cancelSip(req.user, Number(req.params.id)); return { ok: true }; });

  // ── IPO
  app.get('/api/ipo', async (req) => {
    let uid = null;
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) { try { uid = (await A.verifyAccess(h.slice(7))).id; } catch { /* anonymous */ } }
    return IPO.list(uid);
  });
  app.post('/api/ipo/:id/apply', authed, async (req) => IPO.apply(req.user, { ...req.body, ipoId: Number(req.params.id) }));
  app.delete('/api/ipo/:id/apply', authed, async (req) => { await IPO.cancel(req.user, Number(req.params.id)); return { ok: true }; });

  app.put('/api/account/safeguard', authed, async (req) => {
    const limit = Math.max(0, Number(req.body?.fnoLossLimit) || 0);
    await db.query('update accounts set fno_loss_limit=$2, fno_paused=$3 where user_id=$1', [req.user.id, limit, !!req.body?.fnoPaused]);
    return F.margins(req.user.id);
  });
}
