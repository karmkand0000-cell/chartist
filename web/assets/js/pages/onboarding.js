import { App } from '../app.js';
import { get, post } from '../api.js';
import { esc, toast } from '../ui.js';

let step = 0, kyc = null;
const STEPS = [
  ['verify', 'Verify mobile & email'], ['pan', 'PAN details'], ['personal', 'Personal details'], ['address', 'Address'],
  ['bank', 'Bank account'], ['nominee', 'Nominee'], ['segments', 'Segments'], ['docs', 'Documents'], ['ipv', 'Verification & e-sign'], ['review', 'Review & submit'],
];
const STATES = ['Andhra Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Odisha', 'Punjab', 'Rajasthan', 'Tamil Nadu', 'Telangana', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Jammu & Kashmir', 'Other'];

function done(k) {
  const u = App.user;
  return {
    verify: u.mobileVerified && u.emailVerified, pan: !!k.pan, personal: !!k.gender, address: !!k.address?.line1, bank: !!k.bank?.ifsc,
    nominee: !!(k.nominee?.name || k.nominee?.opt_out), segments: true,
    docs: ['pan', 'photo', 'signature', 'bank_proof'].every((d) => k.documents.some((x) => x.kind === d)), ipv: k.ipv_done && k.esign_done, review: k.status === 'submitted',
  };
}

function body(k) {
  const v = (x) => esc(x ?? '');
  switch (STEPS[step][0]) {
    case 'verify': {
      const dev = JSON.parse(sessionStorage.getItem('devOtp') || 'null');
      const row = (kind, label, ok) => `<div class="doc-up"><div><b>${label}</b><small class="block muted">${esc(kind === 'mobile' ? App.user.mobile : App.user.email)}</small></div>${ok ? '<span class="tag buy">Verified</span>' : `<form class="row" data-verify="${kind}"><input name="code" class="otp" maxlength="6" inputmode="numeric" placeholder="OTP" style="width:150px" required><button class="btn sm">Verify</button><button type="button" class="btn ghost sm" data-resend="${kind}">Resend</button></form>`}</div>`;
      return `<h3>Verify your contact details</h3>${row('mobile', 'Mobile number', App.user.mobileVerified)}${row('email', 'Email address', App.user.emailVerified)}${dev ? `<p class="note">Development mode — mobile OTP <b>${esc(dev.mobile)}</b>, email OTP <b>${esc(dev.email)}</b></p>` : ''}`;
    }
    case 'pan': return `<h3>PAN details</h3><form data-step="pan"><div class="form-grid"><label>PAN<input name="pan" value="${v(k.pan)}" maxlength="10" style="text-transform:uppercase" placeholder="ABCPE1234F" required></label><label>Date of birth<input name="dob" type="date" value="${v(k.dob)}" required></label></div><label>Name as on PAN<input name="pan_name" value="${v(k.pan_name)}" required></label><button class="btn">Save & continue</button></form>`;
    case 'personal': return `<h3>Personal details</h3><form data-step="personal"><div class="form-grid">
      <label>Gender<select name="gender">${[['M', 'Male'], ['F', 'Female'], ['T', 'Transgender']].map(([a, b]) => `<option value="${a}" ${k.gender === a ? 'selected' : ''}>${b}</option>`).join('')}</select></label>
      <label>Father's / spouse's name<input name="father_name" value="${v(k.father_name)}" required></label>
      <label>Annual income<select name="income_range">${['<1L', '1-5L', '5-10L', '10-25L', '25L-1Cr', '>1Cr'].map((x) => `<option ${k.income_range === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>Occupation<select name="occupation">${['Salaried', 'Business', 'Self-employed', 'Professional', 'Student', 'Retired', 'Homemaker', 'Other'].map((x) => `<option ${k.occupation === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>Trading experience<select name="experience">${['None', '<1 year', '1-5 years', '5+ years'].map((x) => `<option ${k.experience === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label></div>
      <label class="chip"><input type="checkbox" name="pep" ${k.pep ? 'checked' : ''}> I am a politically exposed person (PEP) or related to one</label>
      <label class="chip"><input type="checkbox" name="fatca_ok" ${k.fatca_ok !== false ? 'checked' : ''}> I am a tax resident of India only (FATCA declaration)</label><br><br><button class="btn">Save & continue</button></form>`;
    case 'address': { const a = k.address || {}; return `<h3>Address (as per Aadhaar)</h3><form data-step="address"><label>Address line 1<input name="line1" value="${v(a.line1)}" required></label><label>Address line 2<input name="line2" value="${v(a.line2)}"></label>
      <div class="form-grid"><label>City<input name="city" value="${v(a.city)}" required></label><label>State<select name="state">${STATES.map((s) => `<option ${a.state === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label><label>PIN code<input name="pincode" value="${v(a.pincode)}" inputmode="numeric" maxlength="6" required></label><label>Aadhaar (last 4 digits)<input name="aadhaar_last4" value="${v(k.aadhaar_last4)}" inputmode="numeric" maxlength="4" required></label></div>
      <p class="muted small">Only the last 4 digits are stored. Full Aadhaar e-KYC is done through DigiLocker in production.</p><button class="btn">Save & continue</button></form>`; }
    case 'bank': { const b = k.bank || {}; return `<h3>Bank account</h3><form data-step="bank"><div class="form-grid"><label>IFSC<input name="ifsc" value="${v(b.ifsc)}" maxlength="11" style="text-transform:uppercase" required></label><label>Account number<input name="account_no" inputmode="numeric" placeholder="${b.account_no ? v(b.account_no) : ''}" required></label>
      <label>Account type<select name="account_type"><option value="savings">Savings</option><option value="current" ${b.account_type === 'current' ? 'selected' : ''}>Current</option></select></label><label>Account holder name<input name="holder" value="${v(b.holder)}"></label></div>
      <p class="muted small">Pay-ins are accepted only from, and payouts go only to, this bank account.</p><button class="btn">Save & continue</button></form>`; }
    case 'nominee': { const n = k.nominee || {}; return `<h3>Nominee</h3><form data-step="nominee"><div class="form-grid"><label>Nominee name<input name="name" value="${v(n.name)}"></label><label>Relationship<select name="relation">${['Spouse', 'Father', 'Mother', 'Son', 'Daughter', 'Brother', 'Sister', 'Other'].map((x) => `<option ${n.relation === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label><label>Nominee date of birth<input name="dob" type="date" value="${v(n.dob)}"></label></div>
      <label class="chip"><input type="checkbox" name="opt_out" ${n.opt_out ? 'checked' : ''}> I do not wish to add a nominee (requires declaration)</label><br><br><button class="btn">Save & continue</button></form>`; }
    case 'segments': return `<h3>Choose segments</h3><form data-step="segments"><label class="chip"><input type="checkbox" checked disabled> Equity — delivery &amp; intraday (NSE/BSE)</label><br><br>
      <label class="chip"><input type="checkbox" name="FO" ${k.segments?.includes('FO') ? 'checked' : ''}> Futures &amp; Options (needs income proof)</label>
      <p class="note">⚠️ SEBI study: 9 out of 10 individual traders in equity F&amp;O incurred net losses. Trade derivatives only if you understand the risks.</p><button class="btn">Save & continue</button></form>`;
    case 'docs': {
      const need = [['pan', 'PAN card'], ['photo', 'Photograph'], ['signature', 'Signature'], ['bank_proof', 'Bank proof (cancelled cheque / statement)'], ['aadhaar', 'Aadhaar (masked, optional)'], ['income_proof', `Income proof ${k.segments?.includes('FO') ? '(required for F&O)' : '(optional)'}`]];
      return `<h3>Upload documents</h3><p class="muted small">JPG, PNG or PDF up to 2 MB each.</p>${need.map(([kind, label]) => { const d = k.documents.find((x) => x.kind === kind); return `<div class="doc-up"><div><b>${label}</b><small class="block muted">${d ? `✔ ${esc(d.filename)} (${Math.round(d.size / 1024)} KB)` : 'Not uploaded'}</small></div><label class="btn ghost sm">${d ? 'Replace' : 'Upload'}<input type="file" hidden accept="image/jpeg,image/png,application/pdf" data-doc="${kind}"></label></div>`; }).join('')}<br><button class="btn" data-next>Continue</button>`;
    }
    case 'ipv': return `<h3>In-person verification &amp; e-sign</h3>
      <div class="doc-up"><div><b>In-person verification (IPV)</b><small class="block muted">Record a short selfie video reading the OTP shown on screen.</small></div>${k.ipv_done ? '<span class="tag buy">Done</span>' : '<button class="btn sm" data-act="ipv">Start IPV</button>'}</div>
      <div class="doc-up"><div><b>Aadhaar e-sign</b><small class="block muted">Sign the account opening form digitally with Aadhaar OTP.</small></div>${k.esign_done ? '<span class="tag buy">Signed</span>' : '<button class="btn sm" data-act="esign">e-Sign form</button>'}</div>
      <p class="note">Simulator: IPV and e-sign are marked complete instantly. In production these connect to a video-KYC vendor and a licensed eSign service provider.</p>`;
    case 'review': return `<h3>Review &amp; submit</h3><table class="tbl"><tbody>
      <tr><td>Name</td><td>${v(k.pan_name)}</td></tr><tr><td>PAN</td><td>${v(k.pan)}</td></tr><tr><td>DOB</td><td>${v(k.dob)}</td></tr>
      <tr><td>Address</td><td>${v([k.address?.line1, k.address?.city, k.address?.state, k.address?.pincode].filter(Boolean).join(', '))}</td></tr>
      <tr><td>Bank</td><td>${v(k.bank?.ifsc)} · ${v(k.bank?.account_no)}</td></tr><tr><td>Nominee</td><td>${k.nominee?.opt_out ? 'Opted out' : v(k.nominee?.name)}</td></tr><tr><td>Segments</td><td>${v((k.segments || []).join(', '))}</td></tr>
      <tr><td>Documents</td><td>${k.documents.map((d) => d.kind).join(', ') || '—'}</td></tr></tbody></table>
      <p class="form-err" id="subErr"></p><button class="btn lg" data-act="submit">Submit application</button>`;
  }
  return '';
}

export default {
  title: 'Open account', auth: true,
  async render() {
    await App.refreshUser();
    kyc = await get('/api/kyc');
    const u = App.user;
    if (u.status === 'active') return `<section class="page"><div class="card"><h1>Your account is active ✅</h1><p>Client ID <b>${esc(u.ucc)}</b>. <a href="#/funds">Add funds</a> to start trading.</p></div></section>`;
    if (kyc.status === 'submitted') return `<section class="page"><div class="card"><h1>Application under review ⏳</h1><p>We are verifying your documents. You will be notified when your account is activated (usually within 24 hours).</p><p class="muted">Submitted ${new Date(kyc.submitted_at).toLocaleString('en-IN')}</p></div></section>`;
    const d = done(kyc);
    if (step === 0 && d.verify) step = STEPS.findIndex(([k]) => !d[k]); if (step < 0) step = STEPS.length - 1;
    return `<section class="page"><div class="page-head"><h1>Open your account</h1></div>
      ${kyc.status === 'rejected' ? `<div class="banner"><span><b>Changes needed:</b> ${esc(kyc.remarks)}</span></div>` : ''}
      <div class="wizard"><ol class="wsteps">${STEPS.map(([k, l], i) => `<li class="${i === step ? 'on' : ''} ${d[k] ? 'done' : ''}" data-go="${i}"><i>${d[k] ? '✓' : i + 1}</i><span>${l}</span></li>`).join('')}</ol>
      <div class="card" id="stepBody">${body(kyc)}</div></div></section>`;
  },
  mount(root) {
    const reload = async () => { const { rerender } = await import('../app.js'); rerender(); };
    root.onclick = async (e) => {
      const t = e.target;
      if (t.closest('[data-go]')) { step = +t.closest('[data-go]').dataset.go; return reload(); }
      if (t.dataset.resend) { const r = await post('/api/me/resend-otp', { kind: t.dataset.resend }); if (r.devOtp) toast(`Dev OTP: ${r.devOtp}`); else toast('OTP sent'); }
      if (t.dataset.next != null) { step++; reload(); }
      if (t.dataset.act === 'ipv' || t.dataset.act === 'esign') { await post(`/api/kyc/step/${t.dataset.act}`); toast('Done', 'success'); reload(); }
      if (t.dataset.act === 'submit') {
        try { await post('/api/kyc/submit'); toast('Application submitted', 'success'); reload(); }
        catch (x) { root.querySelector('#subErr').textContent = x.message; }
      }
    };
    root.onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        if (f.dataset.verify) { await post('/api/me/verify', { kind: f.dataset.verify, code: f.code.value }); await App.refreshUser(); toast('Verified', 'success'); return reload(); }
        const d = Object.fromEntries(new FormData(f));
        if (f.dataset.step === 'personal') { d.pep = !!f.pep.checked; d.fatca_ok = !!f.fatca_ok.checked; }
        if (f.dataset.step === 'nominee') d.opt_out = !!f.opt_out.checked;
        if (f.dataset.step === 'segments') d.segments = ['EQ', ...(f.FO.checked ? ['FO'] : [])];
        await post(`/api/kyc/step/${f.dataset.step}`, d);
        step++; reload();
      } catch (x) { toast(x.message, 'error', 5000); }
    };
    root.onchange = async (e) => {
      const inp = e.target; if (!inp.dataset.doc || !inp.files[0]) return;
      const file = inp.files[0];
      if (file.size > 2 * 1024 * 1024) return toast('File must be under 2 MB', 'error');
      const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(file); });
      try { await post('/api/kyc/documents', { kind: inp.dataset.doc, filename: file.name, mime: file.type, data }); toast('Uploaded', 'success'); reload(); } catch (x) { toast(x.message, 'error'); }
    };
  },
};
