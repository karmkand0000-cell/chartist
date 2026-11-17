// Back-office / admin API (/api/admin/...) — roles: admin, rms, ops, support
import { db } from '../db.js';
import { bad, notFound } from '../errors.js';
import { requireRole } from '../auth-hook.js';
import * as K from '../services/kyc.js';
import * as F from '../services/funds.js';
import * as P from '../services/portfolio.js';
import * as O from '../services/oms.js';
import * as M from '../services/market.js';
import { runEod } from '../services/eod.js';
import { audit, notify } from '../services/audit.js';
import { allSettings, setSetting, DEFAULTS } from '../services/settings.js';
import { allInstruments, loadCache } from '../services/instruments.js';
import { publicUser } from '../services/auth.js';
import { displayName, istParts } from '../../../shared/util.js';

export default async function adminRoutes(app) {
  const staff = { preHandler: requireRole('admin', 'rms', 'ops', 'support') };
  const ops = { preHandler: requireRole('admin', 'ops') };
  const rms = { preHandler: requireRole('admin', 'rms') };
  const admin = { preHandler: requireRole('admin') };

  app.get('/api/admin/dashboard', staff, async () => {
    const today = istParts().date;
    const one = (s, p) => db.one(s, p);
    return {
      users: await db.query(`select status, count(*)::int n from users where role='client' group by status`),
      kycPending: (await one(`select count(*)::int n from kyc where status='submitted'`)).n,
      fundPending: (await one(`select count(*)::int n from fund_requests where status='pending'`)).n,
      clientCash: (await one(`select coalesce(sum(a.cash),0) s from accounts a join users u on u.id=a.user_id where u.role='client'`)).s,
      today: await one(`select count(*)::int trades, coalesce(sum(qty*price),0) turnover, count(distinct user_id)::int traders from trades where trade_date=$1`, [today]),
      ordersToday: await db.query(`select status, count(*)::int n from orders where trade_date=$1 group by status`, [today]),
      openPositions: (await one(`select count(*)::int n from positions where qty <> 0`)).n,
      riskEvents: await db.query('select r.*, u.name, u.ucc from risk_events r left join users u on u.id=r.user_id order by r.id desc limit 10'),
      market: M.marketStatus(), exchange: O.exchangeName(), settings: allSettings(),
      lastEod: await one('select * from eod_runs order by trade_date desc limit 1'),
    };
  });

  // Clients
  app.get('/api/admin/clients', staff, async (req) => {
    const q = `%${String(req.query.q || '').toLowerCase()}%`;
    return db.query(`select u.id, u.name, u.email, u.mobile, u.ucc, u.status, u.role, u.created_at, u.last_login_at, a.cash, a.trading_blocked, k.status kyc_status
      from users u left join accounts a on a.user_id=u.id left join kyc k on k.user_id=u.id
      where (lower(u.name) like $1 or lower(u.email) like $1 or u.mobile like $1 or lower(coalesce(u.ucc,'')) like $1) and ($2 = '' or u.status = $2)
      order by u.id desc limit 300`, [q, String(req.query.status || '')]);
  });
  app.get('/api/admin/clients/:id', staff, async (req) => {
    const id = Number(req.params.id);
    const u = await db.one('select * from users where id=$1', [id]); if (!u) throw notFound();
    return {
      user: publicUser(u), account: await db.one('select * from accounts where user_id=$1', [id]), funds: await F.margins(id),
      kyc: await K.getKyc(id), positions: await P.positions(id), holdings: await P.holdings(id),
      orders: (await db.query('select * from orders where user_id=$1 order by id desc limit 100', [id])).map(O.decorate),
      ledger: await db.query('select * from ledger where user_id=$1 order by id desc limit 50', [id]),
      sessions: await db.query('select id, device, ip, created_at from sessions where user_id=$1 and not revoked and expires_at > now()', [id]),
    };
  });
  app.post('/api/admin/clients/:id/status', ops, async (req) => {
    const st = req.body?.status;
    if (!['active', 'suspended', 'closed'].includes(st)) throw bad('Invalid status');
    await db.query('update users set status=$2 where id=$1', [req.params.id, st]);
    if (st !== 'active') await db.query('update sessions set revoked=true where user_id=$1', [req.params.id]);
    await audit(req.user, `client_${st}`, 'user', req.params.id, { reason: req.body?.reason }, req.ip);
    return { ok: true };
  });
  app.put('/api/admin/clients/:id/limits', rms, async (req) => {
    const b = req.body || {};
    await db.query(`update accounts set max_order_value=coalesce($2, max_order_value), fno_loss_limit=coalesce($3, fno_loss_limit), trading_blocked=coalesce($4, trading_blocked) where user_id=$1`,
      [req.params.id, b.maxOrderValue ?? null, b.fnoLossLimit ?? null, b.tradingBlocked ?? null]);
    await audit(req.user, 'limits_updated', 'account', req.params.id, b, req.ip);
    return F.margins(Number(req.params.id));
  });
  app.post('/api/admin/clients/:id/square-off', rms, async (req) => {
    const r = await O.squareOffUser(Number(req.params.id), ['MIS', 'NRML'], req.body?.reason || 'Squared off by RMS', req.user);
    await audit(req.user, 'rms_square_off', 'user', req.params.id, { reason: req.body?.reason }, req.ip);
    return r;
  });
  app.post('/api/admin/clients/:id/role', admin, async (req) => {
    if (!['client', 'admin', 'rms', 'ops', 'support'].includes(req.body?.role)) throw bad('Invalid role');
    await db.query('update users set role=$2 where id=$1', [req.params.id, req.body.role]);
    await audit(req.user, 'role_changed', 'user', req.params.id, { role: req.body.role }, req.ip);
    return { ok: true };
  });

  // KYC
  app.get('/api/admin/kyc', ops, async (req) => db.query(`select k.user_id, k.status, k.pan, k.pan_name, k.segments, k.submitted_at, k.remarks, u.name, u.email, u.mobile
    from kyc k join users u on u.id=k.user_id where k.status = $1 order by k.submitted_at nulls last, k.user_id`, [req.query.status || 'submitted']));
  app.get('/api/admin/kyc/:userId', ops, async (req) => {
    const k = await db.one('select * from kyc where user_id=$1', [req.params.userId]); if (!k) throw notFound();
    const u = await db.one('select * from users where id=$1', [req.params.userId]);
    return { user: publicUser(u), kyc: { ...k }, documents: await db.query('select id, kind, filename, mime, size from kyc_documents where user_id=$1', [req.params.userId]) };
  });
  app.get('/api/admin/kyc/doc/:id', ops, async (req, reply) => { const d = await K.getDocument(req.params.id); reply.type(d.mime).header('Content-Disposition', `inline; filename="${d.filename.replace(/"/g, '')}"`).send(d.data); });
  app.post('/api/admin/kyc/:userId/review', ops, async (req) => { await K.review(req.user, Number(req.params.userId), req.body || {}, req.ip); return { ok: true }; });

  // Funds
  app.get('/api/admin/funds', ops, async (req) => db.query(`select f.*, u.name, u.ucc from fund_requests f join users u on u.id=f.user_id where ($1 = '' or f.status=$1) order by f.id desc limit 300`, [String(req.query.status ?? 'pending')]));
  app.post('/api/admin/funds/:id', ops, async (req) => F.processRequest(req.user, Number(req.params.id), req.body || {}, req.ip));

  // Orders / trades / risk
  app.get('/api/admin/orders', staff, async (req) => (await db.query(`select o.*, u.ucc, u.name as client from orders o join users u on u.id=o.user_id where ($1 = '' or o.status=$1) and o.trade_date >= $2 order by o.id desc limit 500`,
    [String(req.query.status || ''), req.query.from || istParts().date])).map(O.decorate));
  app.get('/api/admin/trades', staff, async (req) => (await db.query(`select t.*, u.ucc from trades t join users u on u.id=t.user_id where t.trade_date >= $1 order by t.id desc limit 500`, [req.query.from || istParts().date])).map((t) => ({ ...t, name: displayName(t.token) })));
  app.get('/api/admin/positions', rms, async () => {
    const rows = await db.query(`select p.user_id, u.ucc, u.name from positions p join users u on u.id=p.user_id where p.qty <> 0 group by p.user_id, u.ucc, u.name`);
    return Promise.all(rows.map(async (r) => ({ ...r, funds: await F.margins(r.user_id), positions: await P.positions(r.user_id) })));
  });
  app.get('/api/admin/risk-events', rms, async () => db.query('select r.*, u.ucc, u.name from risk_events r left join users u on u.id=r.user_id order by r.id desc limit 200'));

  // Platform settings & operations
  app.get('/api/admin/settings', staff, async () => allSettings());
  app.put('/api/admin/settings/:key', admin, async (req) => {
    if (!(req.params.key in DEFAULTS)) throw bad('Unknown setting');
    await setSetting(req.params.key, req.body?.value);
    await audit(req.user, 'setting_changed', 'setting', req.params.key, { value: req.body?.value }, req.ip);
    if (req.params.key === 'market_mode' && req.body?.value === 'open') await O.releaseAmo();
    return allSettings();
  });
  app.post('/api/admin/eod', admin, async (req) => runEod(req.user, { force: !!req.body?.force }));
  app.get('/api/admin/eod', staff, async () => db.query('select * from eod_runs order by trade_date desc limit 30'));
  app.post('/api/admin/broadcast', admin, async (req) => {
    if (!req.body?.title) throw bad('Title required');
    await notify(null, String(req.body.title).slice(0, 120), String(req.body.body || '').slice(0, 1000));
    O.events.emit('broadcast', { title: req.body.title, body: req.body.body });
    await audit(req.user, 'broadcast', null, null, req.body, req.ip);
    return { ok: true };
  });
  app.get('/api/admin/instruments', staff, async (req) => allInstruments().filter((i) => !req.query.segment || i.segment === req.query.segment).slice(0, 2000));
  app.put('/api/admin/instruments/:token', admin, async (req) => {
    const b = req.body || {};
    await db.query('update instruments set lot=coalesce($2,lot), freeze_qty=coalesce($3,freeze_qty), band_pct=coalesce($4,band_pct), active=coalesce($5,active) where token=$1', [req.params.token, b.lot ?? null, b.freeze_qty ?? null, b.band_pct ?? null, b.active ?? null]);
    await loadCache();
    await audit(req.user, 'instrument_updated', 'instrument', req.params.token, b, req.ip);
    return { ok: true };
  });
  app.post('/api/admin/price', admin, async (req) => {
    if (O.exchangeName() !== 'SIMULATOR') throw bad('Only available in simulator');
    if (!M.setPrice(req.body?.token, Number(req.body?.price))) throw bad('Unknown token');
    await audit(req.user, 'sim_price_set', 'instrument', req.body?.token, { price: req.body?.price }, req.ip);
    return M.quote(req.body.token);
  });
  app.get('/api/admin/audit', admin, async (req) => db.query(`select a.*, u.name actor from audit_log a left join users u on u.id=a.actor_id where ($1='' or a.action like $1) order by a.id desc limit 500`, [req.query.action ? `%${req.query.action}%` : '']));
}
