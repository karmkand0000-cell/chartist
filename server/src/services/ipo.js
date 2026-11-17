// IPO centre: listings, ASBA-style applications (funds blocked), allotment & refunds
import { db } from '../db.js';
import { bad, notFound } from '../errors.js';
import { post, margins } from './funds.js';
import { audit, notify } from './audit.js';
import { getInstrument } from './instruments.js';
import { r2, istParts } from '../../../shared/util.js';

export function ipoStatus(i, today = istParts().date) {
  if (['ALLOTTED', 'LISTED', 'CANCELLED'].includes(i.status)) return i.status;
  if (today > i.close_date) return 'CLOSED';
  if (today >= i.open_date) return 'OPEN';
  return 'UPCOMING';
}

export async function seedSampleIpos() {
  if ((await db.one('select count(*)::int n from ipos')).n) return;
  const d = (k) => { const x = new Date(); x.setDate(x.getDate() + k); return x.toISOString().slice(0, 10); };
  const rows = [
    ['Sample Greentech Ltd', 'Mainboard', 270, 285, 52, '₹1,200 Cr', d(-1), d(2), d(6)],
    ['Sample Logistics Ltd', 'SME', 95, 100, 1200, '₹45 Cr', d(0), d(3), d(7)],
    ['Sample Finserv Ltd', 'Mainboard', 410, 432, 34, '₹2,800 Cr', d(7), d(9), d(13)],
  ];
  for (const r of rows) await db.query(`insert into ipos(name, issue_type, price_lo, price_hi, lot, issue_size, open_date, close_date, listing_date, sample) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`, r);
}

export async function list(userId) {
  const rows = await db.query('select * from ipos order by open_date desc limit 100');
  const apps = userId ? await db.query('select * from ipo_applications where user_id=$1', [userId]) : [];
  return rows.map((i) => ({ ...i, state: ipoStatus(i), application: apps.find((a) => a.ipo_id === i.id) || null }));
}

export async function apply(user, { ipoId, lots, price, cutoff, upiId }) {
  if (user.status !== 'active') throw bad('Account not active');
  const i = await db.one('select * from ipos where id=$1', [ipoId]); if (!i) throw notFound();
  if (ipoStatus(i) !== 'OPEN') throw bad('IPO is not open for subscription');
  lots = Math.floor(Number(lots));
  if (!(lots >= 1)) throw bad('Apply for at least 1 lot');
  const px = cutoff ? i.price_hi : Number(price);
  if (!(px >= i.price_lo && px <= i.price_hi)) throw bad(`Bid price must be within ₹${i.price_lo}–${i.price_hi}`);
  if (!/^[\w.-]{2,}@[a-zA-Z]{2,}$/.test(String(upiId || ''))) throw bad('Enter a valid UPI ID (e.g. name@okhdfcbank)');
  const amount = r2(lots * i.lot * px);
  if (i.issue_type === 'Mainboard' && amount > 200000) throw bad('Retail application cannot exceed ₹2,00,000');
  return db.tx(async (t) => {
    if (await t.one('select 1 from ipo_applications where user_id=$1 and ipo_id=$2 and status <> $3', [user.id, ipoId, 'CANCELLED'])) throw bad('You have already applied to this IPO');
    if ((await margins(user.id, t)).available < amount) throw bad('Insufficient funds to block for this application');
    // Simulator: funds are blocked from the trading ledger (production: UPI mandate blocks in the bank account via ASBA)
    await post(t, user.id, 'IPO_BLOCK', { debit: amount, ref: `IPO-${ipoId}`, narration: `IPO application: ${i.name} (${lots} lot × ${i.lot} @ ₹${px})` });
    const a = await t.one(`insert into ipo_applications(user_id, ipo_id, lots, price, amount, upi_id) values ($1,$2,$3,$4,$5,$6)
      on conflict (user_id, ipo_id) do update set lots=$3, price=$4, amount=$5, upi_id=$6, status='APPLIED', created_at=now() returning *`, [user.id, ipoId, lots, px, amount, upiId]);
    await audit(user, 'ipo_applied', 'ipo_application', a.id, { ipoId, lots, px }, null, t);
    return a;
  });
}

export async function cancel(user, ipoId) {
  return db.tx(async (t) => {
    const a = await t.one(`select a.*, i.name, i.close_date, i.status ist, i.open_date from ipo_applications a join ipos i on i.id=a.ipo_id where a.user_id=$1 and a.ipo_id=$2 and a.status='APPLIED' for update`, [user.id, ipoId]);
    if (!a) throw bad('No active application');
    if (istParts().date > a.close_date) throw bad('Bidding has closed; application cannot be withdrawn');
    await t.query(`update ipo_applications set status='CANCELLED' where id=$1`, [a.id]);
    await post(t, user.id, 'IPO_REFUND', { credit: a.amount, ref: `IPO-${ipoId}`, narration: `IPO application withdrawn: ${a.name}` });
  });
}

// Back office: run a simple lottery allotment (each application gets 1 lot with probability pct)
export async function allot(admin, ipoId, { pct = 30, listingPrice }) {
  const i = await db.one('select * from ipos where id=$1', [ipoId]); if (!i) throw notFound();
  if (ipoStatus(i) !== 'CLOSED') throw bad('Allotment can be run only after the IPO closes');
  const apps = await db.query(`select * from ipo_applications where ipo_id=$1 and status='APPLIED'`, [ipoId]);
  let won = 0;
  for (const a of apps) {
    const ok = Math.random() * 100 < Number(pct);
    await db.tx(async (t) => {
      const cost = ok ? r2(i.lot * a.price) : 0;
      const refund = r2(a.amount - cost);
      await t.query('update ipo_applications set status=$2, allotted_lots=$3 where id=$1', [a.id, ok ? 'ALLOTTED' : 'NOT_ALLOTTED', ok ? 1 : 0]);
      if (refund > 0) await post(t, a.user_id, 'IPO_REFUND', { credit: refund, ref: `IPO-${ipoId}`, narration: `IPO refund: ${i.name}` });
      const token = i.symbol ? `NSE:${i.symbol}` : null;
      if (ok && token && getInstrument(token)) {
        await t.query(`insert into holdings(user_id, token, qty, t1_qty, avg) values ($1,$2,0,$3,$4) on conflict (user_id, token) do update set t1_qty = holdings.t1_qty + $3, avg = (holdings.avg * (holdings.qty + holdings.t1_qty) + $4 * $3) / (holdings.qty + holdings.t1_qty + $3)`, [a.user_id, token, i.lot, a.price]);
      }
      await notify(a.user_id, ok ? `🎉 IPO allotted: ${i.name}` : `IPO not allotted: ${i.name}`, ok ? `1 lot (${i.lot} shares) allotted @ ₹${a.price}.` : `Your ₹${a.amount} has been released.`, t);
    });
    if (ok) won++;
  }
  await db.query(`update ipos set status='ALLOTTED', listing_price=coalesce($2, listing_price) where id=$1`, [ipoId, listingPrice || null]);
  await audit(admin, 'ipo_allotment', 'ipo', ipoId, { applications: apps.length, allotted: won, pct });
  return { applications: apps.length, allotted: won };
}

export async function create(admin, b) {
  for (const k of ['name', 'price_lo', 'price_hi', 'lot', 'open_date', 'close_date']) if (!b[k]) throw bad(`${k} is required`);
  const r = await db.one(`insert into ipos(name, symbol, issue_type, price_lo, price_hi, lot, issue_size, open_date, close_date, listing_date) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [b.name, b.symbol || null, b.issue_type || 'Mainboard', b.price_lo, b.price_hi, b.lot, b.issue_size || null, b.open_date, b.close_date, b.listing_date || null]);
  await audit(admin, 'ipo_created', 'ipo', r.id, b);
  return r;
}
