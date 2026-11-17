// Authentication: signup, OTP verification, password + mandatory second factor (TOTP or OTP), sessions
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { db } from '../db.js';
import { config } from '../config.js';
import { bad, unauth, conflict, forbidden } from '../errors.js';
import { audit } from './audit.js';
import { deliverOtp } from './messaging.js';

authenticator.options = { window: 1 };
const sha = (s) => crypto.createHmac('sha256', config.jwtSecret).update(String(s)).digest('hex');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE = /^[6-9]\d{9}$/;
export const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, mobile: u.mobile, role: u.role, status: u.status, ucc: u.ucc, totpEnabled: u.totp_enabled, emailVerified: u.email_verified, mobileVerified: u.mobile_verified });

function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 8 || !/[A-Za-z]/.test(p) || !/\d/.test(p)) throw bad('Password must be at least 8 characters with letters and numbers');
}

export async function issueOtp(userId, target, purpose, h = db) {
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await h.query('update otps set used = true where user_id = $1 and purpose = $2 and not used', [userId, purpose]);
  await h.query(`insert into otps(user_id, target, purpose, code_hash, expires_at) values ($1,$2,$3,$4, now() + interval '5 minutes')`, [userId, target, purpose, sha(code)]);
  await deliverOtp(target, code, purpose);
  return config.showOtp ? code : undefined;
}
export async function checkOtp(userId, purpose, code) {
  const o = await db.one('select * from otps where user_id=$1 and purpose=$2 and not used order by id desc limit 1', [userId, purpose]);
  if (!o || new Date(o.expires_at) < new Date()) throw bad('OTP expired. Please request a new one.', 'OTP_EXPIRED');
  if (o.attempts >= 5) throw bad('Too many attempts. Request a new OTP.', 'OTP_LOCKED');
  if (o.code_hash !== sha(code)) { await db.query('update otps set attempts = attempts + 1 where id=$1', [o.id]); throw bad('Incorrect OTP', 'OTP_INVALID'); }
  await db.query('update otps set used = true where id=$1', [o.id]);
}

export async function signup({ name, email, mobile, password }, ip) {
  name = String(name || '').trim(); email = String(email || '').trim().toLowerCase(); mobile = String(mobile || '').replace(/\D/g, '').slice(-10);
  if (name.length < 2) throw bad('Please enter your full name');
  if (!EMAIL.test(email)) throw bad('Please enter a valid email');
  if (!MOBILE.test(mobile)) throw bad('Please enter a valid 10-digit Indian mobile number');
  checkPassword(password);
  if (await db.one('select 1 from users where email=$1 or mobile=$2', [email, mobile])) throw conflict('An account with this email or mobile already exists');
  const hash = await bcrypt.hash(password, 10);
  const user = await db.tx(async (t) => {
    const u = await t.one('insert into users(name, email, mobile, password_hash) values ($1,$2,$3,$4) returning *', [name, email, mobile, hash]);
    await t.query('insert into accounts(user_id) values ($1)', [u.id]);
    await t.query('insert into kyc(user_id) values ($1)', [u.id]);
    await t.query(`insert into watchlists(user_id, name, tokens) values ($1, 'Watchlist 1', $2)`, [u.id, ['IDX:NIFTY50', 'IDX:BANKNIFTY', 'NSE:RELIANCE', 'NSE:HDFCBANK', 'NSE:TCS', 'NSE:INFY', 'NSE:ICICIBANK', 'NSE:SBIN']]);
    return u;
  });
  const mobileOtp = await issueOtp(user.id, mobile, 'verify_mobile');
  const emailOtp = await issueOtp(user.id, email, 'verify_email');
  await audit(user, 'signup', 'user', user.id, { email, mobile }, ip);
  return { user: publicUser(user), ...(config.showOtp ? { devOtp: { mobile: mobileOtp, email: emailOtp } } : {}) };
}

export async function verifyContact(user, kind, code) {
  if (!['mobile', 'email'].includes(kind)) throw bad('Invalid target');
  await checkOtp(user.id, `verify_${kind}`, code);
  await db.query(`update users set ${kind}_verified = true where id=$1`, [user.id]);
}
export async function resendOtp(user, kind) {
  const u = await db.one('select * from users where id=$1', [user.id]);
  return issueOtp(u.id, kind === 'email' ? u.email : u.mobile, `verify_${kind}`);
}

const ticket = (u, mfa) => jwt.sign({ sub: u.id, mfa, typ: 'mfa' }, config.jwtSecret, { expiresIn: '5m' });

export async function login({ login, password }, ip) {
  const id = String(login || '').trim().toLowerCase();
  const u = await db.one('select * from users where email=$1 or mobile=$1 or upper(ucc)=upper($1)', [id]);
  if (!u) throw unauth('Incorrect login or password');
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw forbidden('Account locked after failed attempts. Try again in 15 minutes or reset your password.');
  if (['suspended', 'closed'].includes(u.status)) throw forbidden(`Account ${u.status}. Contact support.`);
  if (!(await bcrypt.compare(String(password || ''), u.password_hash))) {
    const n = u.failed_logins + 1;
    await db.query(`update users set failed_logins=$2, locked_until = case when $2 >= 5 then now() + interval '15 minutes' else null end where id=$1`, [u.id, n]);
    await audit(u, 'login_failed', 'user', u.id, { n }, ip);
    throw unauth(n >= 5 ? 'Too many attempts. Account locked for 15 minutes.' : 'Incorrect login or password');
  }
  if (!config.require2FA) return issueSession(u, ip);
  if (u.totp_enabled) return { mfa: 'TOTP', ticket: ticket(u, 'TOTP') };
  const dev = await issueOtp(u.id, u.mobile, 'login');
  return { mfa: 'OTP', ticket: ticket(u, 'OTP'), sentTo: `******${u.mobile.slice(-4)}`, ...(dev ? { devOtp: dev } : {}) };
}

export async function completeMfa({ ticket: t, code, device }, ip) {
  let p;
  try { p = jwt.verify(t, config.jwtSecret); } catch { throw unauth('Login session expired. Please log in again.'); }
  if (p.typ !== 'mfa') throw unauth();
  const u = await db.one('select * from users where id=$1', [p.sub]);
  if (p.mfa === 'TOTP') { if (!authenticator.check(String(code), u.totp_secret)) throw bad('Invalid authenticator code', 'TOTP_INVALID'); }
  else await checkOtp(u.id, 'login', code);
  return issueSession(u, ip, device);
}

async function issueSession(u, ip, device) {
  const sid = crypto.randomUUID();
  const refresh = crypto.randomBytes(32).toString('base64url');
  await db.query(`insert into sessions(id, user_id, refresh_hash, device, ip, expires_at) values ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)`, [sid, u.id, sha(refresh), device || null, ip || null, String(config.refreshTtlDays)]);
  await db.query('update users set failed_logins=0, locked_until=null, last_login_at=now() where id=$1', [u.id]);
  await audit(u, 'login', 'user', u.id, { device }, ip);
  return { accessToken: jwt.sign({ sub: u.id, role: u.role, sid }, config.jwtSecret, { expiresIn: config.accessTtlSec }), refreshToken: `${sid}.${refresh}`, user: publicUser(u) };
}

export async function refresh(token) {
  const [sid, raw] = String(token || '').split('.');
  const s = await db.one('select * from sessions where id=$1', [sid]);
  if (!s || s.revoked || new Date(s.expires_at) < new Date() || s.refresh_hash !== sha(raw)) throw unauth('Session expired');
  const u = await db.one('select * from users where id=$1', [s.user_id]);
  if (['suspended', 'closed'].includes(u.status)) throw forbidden('Account not active');
  const next = crypto.randomBytes(32).toString('base64url');
  await db.query('update sessions set refresh_hash=$2 where id=$1', [sid, sha(next)]);
  return { accessToken: jwt.sign({ sub: u.id, role: u.role, sid }, config.jwtSecret, { expiresIn: config.accessTtlSec }), refreshToken: `${sid}.${next}`, user: publicUser(u) };
}

export async function verifyAccess(token) {
  let p;
  try { p = jwt.verify(token, config.jwtSecret); } catch { throw unauth('Session expired'); }
  if (!p.sid) throw unauth();
  const row = await db.one(`select u.*, s.revoked from sessions s join users u on u.id = s.user_id where s.id=$1`, [p.sid]);
  if (!row || row.revoked) throw unauth('Session ended');
  if (['suspended', 'closed'].includes(row.status)) throw forbidden('Account not active');
  return { ...row, sid: p.sid };
}

export async function logout(user) { await db.query('update sessions set revoked=true where id=$1', [user.sid]); }
export async function logoutAll(user) { await db.query('update sessions set revoked=true where user_id=$1', [user.id]); }
export async function listSessions(user) {
  return db.query('select id, device, ip, created_at, expires_at, (id = $2) as current from sessions where user_id=$1 and not revoked and expires_at > now() order by created_at desc', [user.id, user.sid]);
}

export async function totpSetup(user) {
  const secret = authenticator.generateSecret();
  await db.query('update users set totp_secret=$2 where id=$1 and not totp_enabled', [user.id, secret]);
  const uri = authenticator.keyuri(user.ucc || user.email, config.brokerName, secret);
  return { secret, uri, qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 }) };
}
export async function totpEnable(user, code) {
  const u = await db.one('select totp_secret from users where id=$1', [user.id]);
  if (!u.totp_secret || !authenticator.check(String(code), u.totp_secret)) throw bad('Invalid code. Check the time on your phone and try again.');
  await db.query('update users set totp_enabled=true where id=$1', [user.id]);
  await audit(user, 'totp_enabled', 'user', user.id);
}

export async function changePassword(user, { current, next }) {
  const u = await db.one('select password_hash from users where id=$1', [user.id]);
  if (!(await bcrypt.compare(String(current || ''), u.password_hash))) throw bad('Current password is incorrect');
  checkPassword(next);
  await db.query('update users set password_hash=$2 where id=$1', [user.id, await bcrypt.hash(next, 10)]);
  await db.query('update sessions set revoked=true where user_id=$1 and id <> $2', [user.id, user.sid]);
  await audit(user, 'password_changed', 'user', user.id);
}

export async function forgotPassword(login) {
  const u = await db.one('select * from users where email=$1 or mobile=$1', [String(login || '').trim().toLowerCase()]);
  if (!u) return {}; // do not reveal whether the account exists
  const dev = await issueOtp(u.id, u.mobile, 'reset');
  return dev ? { devOtp: dev } : {};
}
export async function resetPassword({ login, code, password }) {
  const u = await db.one('select * from users where email=$1 or mobile=$1', [String(login || '').trim().toLowerCase()]);
  if (!u) throw bad('Invalid request');
  await checkOtp(u.id, 'reset', code);
  checkPassword(password);
  await db.query('update users set password_hash=$2, failed_logins=0, locked_until=null where id=$1', [u.id, await bcrypt.hash(password, 10)]);
  await db.query('update sessions set revoked=true where user_id=$1', [u.id]);
  await audit(u, 'password_reset', 'user', u.id);
}

export async function ensureAdmin() {
  if (await db.one(`select 1 from users where role='admin'`)) return;
  if (!config.adminPassword) { console.warn('No admin user exists. Set ADMIN_EMAIL and ADMIN_PASSWORD to create one.'); return; }
  const u = await db.one(`insert into users(role, name, email, mobile, password_hash, status, email_verified, mobile_verified, ucc)
    values ('admin','Administrator',$1,'9000000000',$2,'active',true,true,'ADMIN1') returning *`, [config.adminEmail, await bcrypt.hash(config.adminPassword, 10)]);
  await db.query('insert into accounts(user_id) values ($1)', [u.id]);
  console.log(`Admin user created: ${config.adminEmail}`);
}

export const DEMO = { email: 'demo@chartist.in', password: 'Demo@1234' };
export async function ensureDemo() {
  if (!config.demoSeed || await db.one('select 1 from users where email=$1', [DEMO.email])) return;
  const u = await db.one(`insert into users(name, email, mobile, password_hash, status, email_verified, mobile_verified, ucc)
    values ('Demo Trader',$1,'9999999999',$2,'active',true,true,'CHDEMO1') returning *`, [DEMO.email, await bcrypt.hash(DEMO.password, 10)]);
  await db.query('insert into accounts(user_id, cash) values ($1, 1000000)', [u.id]);
  await db.query(`insert into ledger(user_id, entry_date, type, credit, balance, narration) values ($1, (now() at time zone 'Asia/Kolkata')::date, 'PAYIN', 1000000, 1000000, 'Demo funds')`, [u.id]);
  await db.query(`insert into kyc(user_id, pan, pan_name, dob, gender, segments, status, ipv_done, esign_done) values ($1,'AAAPD0000D','DEMO TRADER','1990-01-01','M','{EQ,FO}','approved',true,true)`, [u.id]);
  await db.query(`insert into watchlists(user_id, name, tokens) values ($1,'Watchlist 1',$2)`, [u.id, ['IDX:NIFTY50', 'IDX:BANKNIFTY', 'NSE:RELIANCE', 'NSE:HDFCBANK', 'NSE:TCS', 'NSE:INFY', 'NSE:ICICIBANK', 'NSE:SBIN']]);
  console.log('Demo client created:', DEMO.email);
}
