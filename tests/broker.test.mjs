// End-to-end API test: onboarding → KYC → funds → orders (equity + F&O) → RMS → EOD → payout
process.env.PGLITE_DIR = '';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';
process.env.DEV_MODE = '1';
process.env.SIM_TICK_MS = '100000';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { build } = await import('../server/src/server.js');
const { db } = await import('../server/src/db.js');
let app;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, body, token) {
  const r = await app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const json = r.headers['content-type']?.includes('json') ? r.json() : r.body;
  return { status: r.statusCode, body: json };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

async function loginFlow(login, password) {
  const l = await ok('POST', '/api/auth/login', { login, password });
  assert.equal(l.mfa, 'OTP');
  const s = await ok('POST', '/api/auth/mfa', { ticket: l.ticket, code: l.devOtp });
  return s.accessToken;
}
const img = Buffer.from('fake-image-bytes').toString('base64');
let admin, client, uid;

before(async () => { app = await build({ logger: false, background: false }); });
after(async () => { await app.close(); await db.close(); });

test('signup, verify contacts and 2FA login', async () => {
  const s = await ok('POST', '/api/auth/signup', { name: 'Neeraj Test', email: 'neeraj@example.com', mobile: '9876543210', password: 'Trade1234' });
  uid = s.user.id;
  const weak = await call('POST', '/api/auth/signup', { name: 'X Y', email: 'x@example.com', mobile: '9876500000', password: 'short' });
  assert.equal(weak.status, 400);
  client = await loginFlow('neeraj@example.com', 'Trade1234');
  await ok('POST', '/api/me/verify', { kind: 'mobile', code: s.devOtp.mobile }, client);
  await ok('POST', '/api/me/verify', { kind: 'email', code: s.devOtp.email }, client);
  const bad = await call('POST', '/api/auth/login', { login: 'neeraj@example.com', password: 'wrong' });
  assert.equal(bad.status, 401);
});

test('trading is blocked before KYC approval', async () => {
  const r = await call('POST', '/api/orders', { token: 'NSE:RELIANCE', side: 'BUY', qty: 1, order_type: 'MARKET', product: 'CNC' }, client);
  assert.equal(r.status, 403);
});

test('KYC wizard, validation and submission', async () => {
  const badPan = await call('POST', '/api/kyc/step/pan', { pan: 'ABCDE1234', pan_name: 'NEERAJ', dob: '1995-01-01' }, client);
  assert.equal(badPan.status, 400);
  await ok('POST', '/api/kyc/step/pan', { pan: 'ABCPK1234F', pan_name: 'Neeraj Kumar', dob: '1995-01-01' }, client);
  await ok('POST', '/api/kyc/step/personal', { gender: 'M', father_name: 'R Kumar', income_range: '5-10L', occupation: 'Business', experience: '1-5' }, client);
  await ok('POST', '/api/kyc/step/address', { line1: '12 Civil Lines', city: 'Prayagraj', state: 'Uttar Pradesh', pincode: '211001', aadhaar_last4: '1234' }, client);
  await ok('POST', '/api/kyc/step/bank', { ifsc: 'SBIN0001234', account_no: '123456789012', account_type: 'savings' }, client);
  await ok('POST', '/api/kyc/step/nominee', { name: 'Sita Devi', relation: 'Mother' }, client);
  await ok('POST', '/api/kyc/step/segments', { segments: ['EQ', 'FO'] }, client);
  const incomplete = await call('POST', '/api/kyc/submit', {}, client);
  assert.equal(incomplete.status, 400);
  assert.ok(incomplete.body.missing.length > 0);
  for (const kind of ['pan', 'photo', 'signature', 'bank_proof', 'income_proof']) await ok('POST', '/api/kyc/documents', { kind, filename: `${kind}.png`, mime: 'image/png', data: img }, client);
  await ok('POST', '/api/kyc/step/ipv', {}, client);
  await ok('POST', '/api/kyc/step/esign', {}, client);
  await ok('POST', '/api/kyc/submit', {}, client);
  const k = await ok('GET', '/api/kyc', null, client);
  assert.equal(k.status, 'submitted');
  assert.match(k.bank.account_no, /^X+9012$/);
});

test('admin approves KYC; client cannot access admin API', async () => {
  admin = await loginFlow('admin@chartist.in', 'Admin@12345');
  const forbidden = await call('GET', '/api/admin/dashboard', null, client);
  assert.equal(forbidden.status, 403);
  const q = await ok('GET', '/api/admin/kyc', null, admin);
  assert.equal(q.length, 1);
  await ok('POST', `/api/admin/kyc/${uid}/review`, { action: 'approve' }, admin);
  const me = await ok('GET', '/api/me', null, client);
  assert.equal(me.user.status, 'active');
  assert.match(me.user.ucc, /^CH\d{6}$/);
});

test('pay-in request approved by back office credits the ledger', async () => {
  const r = await ok('POST', '/api/funds/payin', { amount: 500000, method: 'UPI', utr: 'UTR123456789' }, client);
  const dup = await call('POST', '/api/funds/payin', { amount: 1000, method: 'UPI', utr: 'UTR123456789' }, client);
  assert.equal(dup.status, 400);
  await ok('POST', `/api/admin/funds/${r.id}`, { action: 'approve' }, admin);
  const f = await ok('GET', '/api/funds', null, client);
  assert.equal(f.cash, 500000);
  assert.equal(f.available, 500000);
});

test('market closed → regular orders rejected, AMO accepted then released at open', async () => {
  await ok('PUT', '/api/admin/settings/market_mode', { value: 'closed' }, admin);
  const r = await call('POST', '/api/orders', { token: 'NSE:ITC', side: 'BUY', qty: 5, order_type: 'MARKET', product: 'CNC' }, client);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'MARKET_CLOSED');
  const amo = await ok('POST', '/api/orders', { token: 'NSE:ITC', side: 'BUY', qty: 5, order_type: 'MARKET', product: 'CNC', variety: 'AMO' }, client);
  assert.equal(amo.status, 'AMO_REQ_RECEIVED');
  await ok('PUT', '/api/admin/settings/market_mode', { value: 'open' }, admin);
  await sleep(80);
  const o = await ok('GET', `/api/orders/${amo.id}`, null, client);
  assert.equal(o.status, 'COMPLETE');
});

test('delivery buy, oversell rejection, holdings in T1', async () => {
  const o = await ok('POST', '/api/orders', { token: 'NSE:RELIANCE', side: 'BUY', qty: 10, order_type: 'MARKET', product: 'CNC', client_order_id: 'abc-1' }, client);
  const again = await ok('POST', '/api/orders', { token: 'NSE:RELIANCE', side: 'BUY', qty: 10, order_type: 'MARKET', product: 'CNC', client_order_id: 'abc-1' }, client);
  assert.equal(again.id, o.id, 'idempotent client_order_id');
  await sleep(60);
  const done = await ok('GET', `/api/orders/${o.id}`, null, client);
  assert.equal(done.status, 'COMPLETE');
  assert.equal(done.trades.length, 1);
  const h = await ok('GET', '/api/holdings', null, client);
  const rel = h.find((x) => x.token === 'NSE:RELIANCE');
  assert.equal(rel.t1_qty, 10);
  const over = await call('POST', '/api/orders', { token: 'NSE:RELIANCE', side: 'SELL', qty: 20, order_type: 'MARKET', product: 'CNC' }, client);
  assert.equal(over.status, 400);
  assert.equal(over.body.order.status, 'REJECTED', 'rejected orders are kept in the order book');
});

test('limit order rests, then fills when price crosses; SL validation', async () => {
  const q = (await ok('GET', '/api/instruments/NSE:SBIN', null, client)).quote;
  const limit = Math.round((q.ltp * 0.98) / 0.05) * 0.05;
  const o = await ok('POST', '/api/orders', { token: 'NSE:SBIN', side: 'BUY', qty: 10, order_type: 'LIMIT', price: limit.toFixed(2), product: 'CNC' }, client);
  await sleep(40);
  assert.equal((await ok('GET', `/api/orders/${o.id}`, null, client)).status, 'OPEN');
  const f1 = await ok('GET', '/api/funds', null, client);
  assert.ok(f1.openOrders > 0, 'funds blocked for open order');
  await ok('POST', '/api/admin/price', { token: 'NSE:SBIN', price: +(limit - 1).toFixed(2) }, admin);
  await sleep(60);
  const filled = await ok('GET', `/api/orders/${o.id}`, null, client);
  assert.equal(filled.status, 'COMPLETE');
  assert.ok(filled.avg_price <= limit);
  const sl = await call('POST', '/api/orders', { token: 'NSE:SBIN', side: 'SELL', qty: 10, order_type: 'SL-M', trigger_price: (limit + 50).toFixed(2), product: 'CNC' }, client);
  assert.equal(sl.status, 400, 'sell SL trigger above LTP is invalid');
  const tick = await call('POST', '/api/orders', { token: 'NSE:SBIN', side: 'BUY', qty: 1, order_type: 'LIMIT', price: '100.03', product: 'CNC' }, client);
  assert.equal(tick.status, 400, 'tick size enforced');
});

test('intraday short sell and cover books realised P&L to ledger', async () => {
  await ok('POST', '/api/admin/price', { token: 'NSE:TCS', price: 3000 }, admin);
  await ok('POST', '/api/orders', { token: 'NSE:TCS', side: 'SELL', qty: 10, order_type: 'MARKET', product: 'MIS' }, client);
  await sleep(50);
  let pos = (await ok('GET', '/api/positions', null, client)).find((p) => p.token === 'NSE:TCS');
  assert.equal(pos.qty, -10);
  await ok('POST', '/api/admin/price', { token: 'NSE:TCS', price: 2950 }, admin);
  await ok('POST', '/api/positions/exit', { token: 'NSE:TCS', product: 'MIS' }, client);
  await sleep(50);
  pos = (await ok('GET', '/api/positions', null, client)).find((p) => p.token === 'NSE:TCS');
  assert.equal(pos.qty, 0);
  assert.ok(pos.realised > 490 && pos.realised < 501, `realised ${pos.realised}`);
  const led = await ok('GET', '/api/reports/ledger', null, client);
  assert.ok(led.some((l) => l.type === 'PNL' && l.credit > 0));
});

test('F&O: hedged iron condor uses spread margin; SafeGuard; lot validation', async () => {
  const ch = await ok('GET', '/api/optionchain/NIFTY', null, client);
  const lot = ch.lot;
  const atm = ch.atm;
  const row = (k) => ch.rows.find((r) => r.strike === k);
  const bad = await call('POST', '/api/orders', { token: row(atm).CE.token, side: 'BUY', qty: lot - 1, order_type: 'MARKET', product: 'NRML' }, client);
  assert.equal(bad.status, 400);
  const legs = [
    { token: row(atm + 200).CE.token, side: 'SELL' }, { token: row(atm + 400).CE.token, side: 'BUY' },
    { token: row(atm - 200).PE.token, side: 'SELL' }, { token: row(atm - 400).PE.token, side: 'BUY' },
  ].map((l) => ({ ...l, qty: lot, order_type: 'MARKET', product: 'NRML' }));
  const res = await ok('POST', '/api/orders/basket', { orders: legs }, client);
  assert.ok(res.every((r) => r.ok), JSON.stringify(res));
  await sleep(80);
  const f = await ok('GET', '/api/funds', null, client);
  assert.ok(f.usedMargin > 0 && f.usedMargin <= 200 * lot + 1, `hedged margin ${f.usedMargin} should be ≤ spread width × lot`);
  await ok('PUT', '/api/account/safeguard', { fnoLossLimit: 25000, fnoPaused: true }, client);
  const paused = await call('POST', '/api/orders', { token: row(atm).CE.token, side: 'BUY', qty: lot, order_type: 'MARKET', product: 'NRML' }, client);
  assert.equal(paused.status, 400);
  assert.match(paused.body.error, /paused/);
  await ok('PUT', '/api/account/safeguard', { fnoLossLimit: 25000, fnoPaused: false }, client);
});

test('insufficient funds and kill switch are enforced by RMS', async () => {
  const big = await call('POST', '/api/orders', { token: 'NSE:MARUTI', side: 'BUY', qty: 400, order_type: 'MARKET', product: 'CNC' }, client);
  assert.equal(big.status, 400);
  assert.ok(['INSUFFICIENT_FUNDS', 'RMS_REJECT'].includes(big.body.code));
  await ok('PUT', '/api/admin/settings/kill_switch', { value: true }, admin);
  const k = await call('POST', '/api/orders', { token: 'NSE:ITC', side: 'BUY', qty: 1, order_type: 'MARKET', product: 'CNC' }, client);
  assert.equal(k.body.code, 'KILL_SWITCH');
  await ok('PUT', '/api/admin/settings/kill_switch', { value: false }, admin);
});

test('EOD: charges posted, contract note, T+1 settlement, payout limits', async () => {
  const before = await ok('GET', '/api/funds', null, client);
  assert.ok(before.accruedCharges > 0);
  const s = await ok('POST', '/api/admin/eod', { force: true }, admin);
  assert.equal(s.contractNotes, 1);
  assert.ok(s.chargesPosted > 0);
  const cns = await ok('GET', '/api/reports/contract-notes', null, client);
  assert.equal(cns.length, 1);
  const html = await call('GET', `/api/reports/contract-notes/${cns[0].id}`, null, client);
  assert.match(html.body, /Contract Note/);
  const h = (await ok('GET', '/api/holdings', null, client)).find((x) => x.token === 'NSE:RELIANCE');
  assert.equal(h.qty, 10); assert.equal(h.t1_qty, 0);
  const f = await ok('GET', '/api/funds', null, client);
  assert.equal(f.accruedCharges, 0);
  const tooMuch = await call('POST', '/api/funds/payout', { amount: f.withdrawable + 1000 }, client);
  assert.equal(tooMuch.status, 400);
  const p = await ok('POST', '/api/funds/payout', { amount: 1000 }, client);
  await ok('POST', `/api/admin/funds/${p.id}`, { action: 'approve' }, admin);
  const again = await call('POST', '/api/admin/eod', {}, admin);
  assert.equal(again.status, 400, 'EOD cannot run twice');
  const pnl = await ok('GET', '/api/reports/pnl', null, client);
  assert.ok(pnl.charges > 0);
  const audit = await ok('GET', '/api/admin/audit', null, admin);
  assert.ok(audit.some((a) => a.action === 'eod_run'));
});

test('mutual funds: lumpsum, SIP, redeem', async () => {
  const schemes = await ok('GET', '/api/mf/schemes');
  assert.ok(schemes.length >= 3);
  const s = schemes[0];
  const before = (await ok('GET', '/api/funds', null, client)).available;
  await ok('POST', '/api/mf/invest', { code: s.code, amount: 5000 }, client);
  const sip = await ok('POST', '/api/mf/sip', { code: s.code, amount: 1000, day: 5, firstToday: true }, client);
  assert.equal(sip.installments, 1);
  const pf = await ok('GET', '/api/mf/portfolio', null, client);
  assert.equal(pf.holdings.length, 1);
  assert.equal(pf.holdings[0].invested, 6000);
  const after = (await ok('GET', '/api/funds', null, client)).available;
  assert.ok(Math.abs(before - after - 6000) < 1);
  await ok('POST', '/api/mf/redeem', { code: s.code, all: true }, client);
  assert.equal((await ok('GET', '/api/mf/portfolio', null, client)).holdings.length, 0);
});

test('IPO: apply blocks funds, allotment refunds or allots', async () => {
  const list = await ok('GET', '/api/ipo', null, client);
  const open = list.find((i) => i.state === 'OPEN');
  assert.ok(open, 'a sample IPO is open');
  const bad = await call('POST', `/api/ipo/${open.id}/apply`, { lots: 1, cutoff: true, upiId: 'bad' }, client);
  assert.equal(bad.status, 400);
  const a = await ok('POST', `/api/ipo/${open.id}/apply`, { lots: 1, cutoff: true, upiId: 'neeraj@okhdfc' }, client);
  assert.equal(a.amount, open.lot * open.price_hi);
  const dup = await call('POST', `/api/ipo/${open.id}/apply`, { lots: 1, cutoff: true, upiId: 'neeraj@okhdfc' }, client);
  assert.equal(dup.status, 400);
  // close it and allot 100%
  await db.query(`update ipos set open_date = current_date - 5, close_date = current_date - 1 where id=$1`, [open.id]);
  const r = await ok('POST', `/api/admin/ipo/${open.id}/allot`, { pct: 100 }, admin);
  assert.equal(r.allotted, 1);
  const led = await ok('GET', '/api/reports/ledger', null, client);
  assert.ok(led.some((l) => l.type === 'IPO_BLOCK'));
});
