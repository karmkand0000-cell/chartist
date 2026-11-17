// KYC onboarding: step-wise data capture, document upload, submission and back-office review
import { db } from '../db.js';
import { bad, forbidden, notFound } from '../errors.js';
import { audit, notify } from './audit.js';

const PAN = /^[A-Z]{3}P[A-Z]\d{4}[A-Z]$/; // individual PAN (4th char P)
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PIN = /^[1-9]\d{5}$/;
const DOC_TYPES = ['pan', 'aadhaar', 'photo', 'signature', 'bank_proof', 'income_proof'];
const MIMES = ['image/jpeg', 'image/png', 'application/pdf'];

const mask = (s, keep = 4) => (s ? `${'X'.repeat(Math.max(0, s.length - keep))}${s.slice(-keep)}` : s);
export function publicKyc(k, docs = []) {
  if (!k) return null;
  return { ...k, bank: k.bank?.account_no ? { ...k.bank, account_no: mask(k.bank.account_no) } : k.bank, documents: docs };
}

export async function getKyc(userId) {
  const k = await db.one('select * from kyc where user_id=$1', [userId]);
  const docs = await db.query('select id, kind, filename, mime, size, created_at from kyc_documents where user_id=$1 order by id', [userId]);
  return publicKyc(k, docs);
}

function age(dob) { const d = new Date(dob); const n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--; return a; }

export async function saveStep(user, step, d = {}) {
  const k = await db.one('select status from kyc where user_id=$1', [user.id]);
  if (['submitted', 'approved'].includes(k.status)) throw forbidden('KYC already submitted');
  switch (step) {
    case 'pan': {
      const pan = String(d.pan || '').toUpperCase().trim();
      if (!PAN.test(pan)) throw bad('Enter a valid individual PAN (e.g. ABCPE1234F)');
      if (!d.pan_name || String(d.pan_name).trim().length < 3) throw bad('Enter the name exactly as on PAN');
      if (!d.dob || isNaN(new Date(d.dob)) || age(d.dob) < 18) throw bad('You must be at least 18 years old');
      if (await db.one('select 1 from kyc where pan=$1 and user_id<>$2', [pan, user.id])) throw bad('This PAN is already registered with another account');
      // Production: verify PAN + name + DOB with NSDL/Protean PAN verification API and fetch KRA record here
      await db.query('update kyc set pan=$2, pan_name=$3, dob=$4, updated_at=now() where user_id=$1', [user.id, pan, String(d.pan_name).trim().toUpperCase(), d.dob]);
      break;
    }
    case 'personal': {
      const inc = ['<1L', '1-5L', '5-10L', '10-25L', '25L-1Cr', '>1Cr'];
      if (!['M', 'F', 'T'].includes(d.gender)) throw bad('Select gender');
      if (!d.father_name) throw bad("Enter father's / spouse's name");
      if (!inc.includes(d.income_range)) throw bad('Select annual income');
      await db.query('update kyc set gender=$2, father_name=$3, income_range=$4, occupation=$5, experience=$6, pep=$7, fatca_ok=$8, updated_at=now() where user_id=$1',
        [user.id, d.gender, String(d.father_name).trim(), d.income_range, d.occupation || null, d.experience || null, !!d.pep, d.fatca_ok !== false]);
      break;
    }
    case 'address': {
      if (!d.line1 || !d.city || !d.state) throw bad('Enter your full address');
      if (!PIN.test(String(d.pincode || ''))) throw bad('Enter a valid 6-digit PIN code');
      if (!/^\d{4}$/.test(String(d.aadhaar_last4 || ''))) throw bad('Enter the last 4 digits of Aadhaar');
      // Production: DigiLocker / Aadhaar offline e-KYC via a licensed KUA/ASP
      await db.query('update kyc set address=$2, aadhaar_last4=$3, updated_at=now() where user_id=$1',
        [user.id, JSON.stringify({ line1: d.line1, line2: d.line2 || '', city: d.city, state: d.state, pincode: d.pincode }), d.aadhaar_last4]);
      break;
    }
    case 'bank': {
      const ifsc = String(d.ifsc || '').toUpperCase();
      if (!IFSC.test(ifsc)) throw bad('Enter a valid IFSC code');
      if (!/^\d{9,18}$/.test(String(d.account_no || ''))) throw bad('Enter a valid bank account number');
      if (!['savings', 'current'].includes(d.account_type)) throw bad('Select account type');
      // Production: penny-drop verification to match account holder name with PAN name
      await db.query('update kyc set bank=$2, updated_at=now() where user_id=$1', [user.id, JSON.stringify({ ifsc, account_no: String(d.account_no), account_type: d.account_type, holder: d.holder || '' })]);
      break;
    }
    case 'nominee': {
      if (d.opt_out) { await db.query(`update kyc set nominee='{"opt_out":true}', updated_at=now() where user_id=$1`, [user.id]); break; }
      if (!d.name || !d.relation) throw bad('Enter nominee name and relationship');
      await db.query('update kyc set nominee=$2, updated_at=now() where user_id=$1', [user.id, JSON.stringify({ name: d.name, relation: d.relation, dob: d.dob || null, share: 100 })]);
      break;
    }
    case 'segments': {
      const segs = (Array.isArray(d.segments) ? d.segments : []).filter((s) => ['EQ', 'FO'].includes(s));
      if (!segs.includes('EQ')) segs.unshift('EQ');
      await db.query('update kyc set segments=$2, updated_at=now() where user_id=$1', [user.id, segs]);
      break;
    }
    case 'ipv': // Production: in-person verification via recorded selfie video with OTP read-out
      await db.query('update kyc set ipv_done=true, updated_at=now() where user_id=$1', [user.id]); break;
    case 'esign': // Production: Aadhaar eSign through a licensed ESP
      await db.query('update kyc set esign_done=true, updated_at=now() where user_id=$1', [user.id]); break;
    default: throw bad('Unknown step');
  }
  await audit(user, `kyc_${step}`, 'kyc', user.id);
  return getKyc(user.id);
}

export async function uploadDocument(user, { kind, filename, mime, data }) {
  if (!DOC_TYPES.includes(kind)) throw bad('Invalid document type');
  if (!MIMES.includes(mime)) throw bad('Upload a JPG, PNG or PDF');
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length || buf.length > 2 * 1024 * 1024) throw bad('File must be under 2 MB');
  const k = await db.one('select status from kyc where user_id=$1', [user.id]);
  if (['submitted', 'approved'].includes(k.status)) throw forbidden('KYC already submitted');
  await db.query('delete from kyc_documents where user_id=$1 and kind=$2', [user.id, kind]);
  await db.query('insert into kyc_documents(user_id, kind, filename, mime, size, data) values ($1,$2,$3,$4,$5,$6)', [user.id, kind, String(filename).slice(0, 120), mime, buf.length, buf]);
  return getKyc(user.id);
}

export async function getDocument(docId) {
  const d = await db.one('select * from kyc_documents where id=$1', [docId]);
  if (!d) throw notFound();
  return d;
}

export async function submit(user) {
  const u = await db.one('select * from users where id=$1', [user.id]);
  const k = await db.one('select * from kyc where user_id=$1', [user.id]);
  const docs = new Set((await db.query('select kind from kyc_documents where user_id=$1', [user.id])).map((r) => r.kind));
  const missing = [];
  if (!u.mobile_verified) missing.push('verify mobile');
  if (!u.email_verified) missing.push('verify email');
  if (!k.pan) missing.push('PAN details');
  if (!k.gender) missing.push('personal details');
  if (!k.address?.line1) missing.push('address');
  if (!k.bank?.ifsc) missing.push('bank account');
  if (!k.nominee?.name && !k.nominee?.opt_out) missing.push('nominee');
  for (const d of ['pan', 'photo', 'signature', 'bank_proof']) if (!docs.has(d)) missing.push(`${d.replace('_', ' ')} document`);
  if (k.segments.includes('FO') && !docs.has('income_proof')) missing.push('income proof (needed for F&O)');
  if (!k.ipv_done) missing.push('in-person verification');
  if (!k.esign_done) missing.push('e-sign');
  if (missing.length) throw bad(`Please complete: ${missing.join(', ')}`, 'KYC_INCOMPLETE', { missing });
  await db.query(`update kyc set status='submitted', submitted_at=now(), remarks=null where user_id=$1`, [user.id]);
  await db.query(`update users set status='kyc_submitted' where id=$1`, [user.id]);
  await audit(user, 'kyc_submitted', 'kyc', user.id);
}

export async function review(admin, userId, { action, remarks }, ip) {
  const k = await db.one('select * from kyc where user_id=$1', [userId]);
  if (!k || k.status !== 'submitted') throw bad('KYC is not awaiting review');
  if (action === 'approve') {
    const ucc = `CH${String(100000 + Number(userId)).slice(-6)}`;
    await db.tx(async (t) => {
      await t.query(`update kyc set status='approved', reviewed_by=$2, reviewed_at=now(), remarks=$3 where user_id=$1`, [userId, admin.id, remarks || null]);
      await t.query(`update users set status='active', ucc=$2 where id=$1`, [userId, ucc]);
      await notify(userId, 'Account activated 🎉', `Your trading account ${ucc} is active. Add funds to start trading.`, t);
    });
    // Production: upload UCC to NSE/BSE, KRA upload, CKYC upload, open demat with CDSL/NSDL
  } else if (action === 'reject') {
    if (!remarks) throw bad('Rejection reason is required');
    await db.query(`update kyc set status='rejected', reviewed_by=$2, reviewed_at=now(), remarks=$3 where user_id=$1`, [userId, admin.id, remarks]);
    await db.query(`update users set status='onboarding' where id=$1`, [userId]);
    await notify(userId, 'KYC needs changes', remarks);
  } else throw bad('Invalid action');
  await audit(admin, `kyc_${action}`, 'kyc', userId, { remarks }, ip);
}

export async function reopenIfRejected(user) {
  await db.query(`update kyc set status='draft' where user_id=$1 and status='rejected'`, [user.id]);
}
