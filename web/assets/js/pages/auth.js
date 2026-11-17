import { App, onLogin } from '../app.js';
import { post } from '../api.js';
import { CONFIG } from '../config.js';
import { esc, toast, LOGO } from '../ui.js';

const card = (inner) => `<section class="auth"><div class="card auth-card"><a class="logo center" href="#/">${LOGO}<span>${esc(CONFIG.brand)}</span></a>${inner}</div></section>`;
let pending = null; // { ticket, mfa, sentTo, devOtp, next }

function mfaForm() {
  return card(`<h1>Two-factor verification</h1><p class="muted">${pending.mfa === 'TOTP' ? 'Enter the 6-digit code from your authenticator app.' : `Enter the OTP sent to ${esc(pending.sentTo)}.`}</p>
    <form id="mfaForm"><label>${pending.mfa === 'TOTP' ? 'Authenticator code' : 'OTP'}<input name="code" class="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required autofocus></label>
    ${pending.devOtp ? `<p class="note">Development mode — OTP: <b>${esc(pending.devOtp)}</b></p>` : ''}
    <p class="form-err" id="err"></p><button class="btn block lg">Verify &amp; continue</button></form>`);
}

export default {
  title: (r) => ({ signup: 'Open account', forgot: 'Reset password' }[r.name] || 'Log in'),
  render(r) {
    if (r.name === 'login' && pending) return mfaForm();
    if (r.name === 'signup') return card(`<h1>Open your trading account</h1><p class="muted">Free, paperless and done in about 10 minutes.</p>
      <form id="f"><label>Full name (as on PAN)<input name="name" required autocomplete="name"></label>
      <div class="form-grid"><label>Mobile<input name="mobile" type="tel" inputmode="numeric" pattern="[6-9][0-9]{9}" required placeholder="10-digit mobile" autocomplete="tel"></label><label>Email<input name="email" type="email" required autocomplete="email"></label></div>
      <label>Create password<input name="password" type="password" minlength="8" required autocomplete="new-password" placeholder="8+ characters, letters & numbers"></label>
      <label class="chip consent"><input type="checkbox" required> I agree to the terms, risk disclosure documents and to receive communication on my registered mobile & email.</label>
      <p class="form-err" id="err"></p><button class="btn block lg">Continue</button></form><p class="center muted">Already have an account? <a href="#/login">Log in</a></p>`);
    if (r.name === 'forgot') return card(`<h1>Reset password</h1><form id="f"><label>Email or mobile<input name="login" required></label>
      <div id="resetStep" hidden><label>OTP<input name="code" class="otp" inputmode="numeric" maxlength="6"></label><label>New password<input name="password" type="password" minlength="8" autocomplete="new-password"></label><p class="note" id="devHint" hidden></p></div>
      <p class="form-err" id="err"></p><button class="btn block lg" id="fb">Send OTP</button></form><p class="center"><a href="#/login">Back to login</a></p>`);
    return card(`<h1>Welcome back</h1><p class="muted">Log in with your email, mobile or client ID.</p>
      <form id="f"><label>Email / mobile / client ID<input name="login" required autocomplete="username"></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label>
      <p class="form-err" id="err"></p><button class="btn block lg">Continue</button></form>
      <p class="center muted"><a href="#/forgot">Forgot password?</a> · New here? <a href="#/signup">Open account</a></p>`);
  },
  mount(root, r) {
    if (App.user && r.name !== 'forgot') return App.go('');
    const err = (m) => { const e = root.querySelector('#err'); if (e) e.textContent = m; };
    const mf = root.querySelector('#mfaForm');
    if (mf) {
      mf.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const s = await post('/api/auth/mfa', { ticket: pending.ticket, code: mf.code.value.trim() });
          const next = pending.next; pending = null;
          await onLogin(s);
          App.go(s.user.status === 'active' ? next || '' : 'onboarding');
        } catch (x) { err(x.message); if (x.status === 401) { pending = null; setTimeout(() => location.reload(), 1200); } }
      };
      return;
    }
    const f = root.querySelector('#f');
    if (r.name === 'signup') {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(f));
        try {
          const s = await post('/api/auth/signup', d);
          if (s.devOtp) sessionStorage.setItem('devOtp', JSON.stringify(s.devOtp));
          const l = await post('/api/auth/login', { login: d.email, password: d.password });
          pending = { ...l, next: 'onboarding' };
          toast('Account created. Verify the OTP to continue.', 'success');
          App.go('login');
        } catch (x) { err(x.message); }
      };
    } else if (r.name === 'forgot') {
      let sent = false;
      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          if (!sent) {
            const res = await post('/api/auth/forgot', { login: f.login.value });
            sent = true; root.querySelector('#resetStep').hidden = false; root.querySelector('#fb').textContent = 'Reset password';
            if (res.devOtp) { const h = root.querySelector('#devHint'); h.hidden = false; h.innerHTML = `Development mode — OTP: <b>${esc(res.devOtp)}</b>`; }
            toast('If the account exists, an OTP has been sent to the registered mobile');
          } else {
            await post('/api/auth/reset', { login: f.login.value, code: f.code.value, password: f.password.value });
            toast('Password updated. Please log in.', 'success'); App.go('login');
          }
        } catch (x) { err(x.message); }
      };
    } else {
      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const l = await post('/api/auth/login', Object.fromEntries(new FormData(f)));
          if (l.accessToken) { await onLogin(l); return App.go(r.query.next || ''); }
          pending = { ...l, next: r.query.next };
          root.innerHTML = mfaForm(); this.mount(root, r);
        } catch (x) { err(x.message); }
      };
    }
  },
};
