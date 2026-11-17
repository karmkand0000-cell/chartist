import { App, rerender, logout } from '../app.js';
import { get, post, put } from '../api.js';
import { esc, inr, toast, confirmBox, dt } from '../ui.js';

export default {
  title: 'Profile & security', auth: true,
  async render() {
    const u = await App.refreshUser();
    const [kyc, sessions, f] = await Promise.all([get('/api/kyc'), get('/api/auth/sessions'), u.status === 'active' ? get('/api/funds') : null]);
    return `<section class="page"><div class="page-head"><h1>Profile &amp; security</h1></div><div class="grid2">
      <div class="card"><h3>Account</h3><dl class="dl"><dt>Name</dt><dd>${esc(u.name)}</dd><dt>Client ID</dt><dd>${esc(u.ucc || '—')}</dd><dt>Email</dt><dd>${esc(u.email)}</dd><dt>Mobile</dt><dd>${esc(u.mobile)}</dd><dt>PAN</dt><dd>${esc(kyc.pan || '—')}</dd><dt>Bank</dt><dd>${esc(kyc.bank?.ifsc || '')} ${esc(kyc.bank?.account_no || '')}</dd><dt>Segments</dt><dd>${esc((kyc.segments || []).join(', '))}</dd><dt>Status</dt><dd>${esc(u.status)}</dd></dl></div>
      <div class="card"><h3>Two-factor authentication</h3>${u.totpEnabled ? '<p>✅ Authenticator app (TOTP) is enabled. You will be asked for a code at every login.</p>' : `<p class="muted">Login currently uses an SMS OTP. Switch to an authenticator app (Google Authenticator, Microsoft Authenticator) for stronger security.</p><button class="btn" id="totp">Set up authenticator</button><div id="totpBox"></div>`}
        <h3 style="margin-top:20px">Change password</h3><form id="pw"><label>Current password<input name="current" type="password" required autocomplete="current-password"></label><label>New password<input name="next" type="password" minlength="8" required autocomplete="new-password"></label><button class="btn ghost">Update password</button></form></div>
      ${f ? `<div class="card"><h3>F&amp;O SafeGuard</h3><p class="muted">Blocks new F&amp;O positions for the day after your realised loss reaches the limit.</p><form id="sg"><label>Daily loss limit (₹)<input name="fnoLossLimit" type="number" min="0" step="1000" value="${f.fnoLossLimit}"></label><label class="chip"><input type="checkbox" name="fnoPaused" ${f.fnoPaused ? 'checked' : ''}> Pause F&amp;O trading</label><p class="small">Today's F&amp;O loss: <b>${inr(f.fnoDayLoss)}</b></p><button class="btn">Save</button></form></div>` : ''}
      <div class="card"><h3>Active sessions</h3><ul class="events">${sessions.map((s) => `<li>${esc((s.device || 'Unknown device').slice(0, 60))} · ${esc(s.ip || '')} <small class="muted">${dt(s.created_at)}</small> ${s.current ? '<span class="tag buy">This device</span>' : ''}</li>`).join('')}</ul><button class="btn ghost danger" id="lo">Log out of all devices</button></div>
    </div></section>`;
  },
  mount(root) {
    const t = root.querySelector('#totp');
    if (t) t.onclick = async () => {
      const s = await post('/api/me/totp/setup');
      root.querySelector('#totpBox').innerHTML = `<div class="qr">${s.qrSvg}</div><p class="small">Or enter this key: <code>${esc(s.secret)}</code></p><form id="te" class="row"><input name="code" class="otp" maxlength="6" inputmode="numeric" placeholder="123456" required style="width:160px"><button class="btn">Enable</button></form>`;
      root.querySelector('#te').onsubmit = async (e) => { e.preventDefault(); try { await post('/api/me/totp/enable', { code: e.target.code.value }); toast('Authenticator enabled', 'success'); rerender(); } catch (x) { toast(x.message, 'error'); } };
    };
    root.querySelector('#pw').onsubmit = async (e) => { e.preventDefault(); try { await post('/api/me/password', Object.fromEntries(new FormData(e.target))); toast('Password updated', 'success'); e.target.reset(); } catch (x) { toast(x.message, 'error'); } };
    const sg = root.querySelector('#sg');
    if (sg) sg.onsubmit = async (e) => { e.preventDefault(); await put('/api/account/safeguard', { fnoLossLimit: sg.fnoLossLimit.value, fnoPaused: sg.fnoPaused.checked }); toast('SafeGuard saved', 'success'); };
    root.querySelector('#lo').onclick = async () => { if (await confirmBox('Log out from all devices including this one?')) { await post('/api/auth/logout-all'); logout(); } };
  },
};
