/* Public pages, applicant portal and the shared case view */
'use strict';

// ================= public =================
const PHASE_STRIP = h`<div class="phases"><div><b>Digitize</b><br>Manual services</div><div><b>Phase 1</b><br>Connect agencies</div><div><b>Phase 2</b><br>Mobile payments</div><div><b>Phase 3</b><br>Portal &amp; workflow</div><div><b>SIP</b><br>Leadership insight</div></div>`;
function authLayout(inner) {
  return h`<div class="auth"><div class="hero"><div class="brand" style="padding:0"><div class="brand-mark" style="background:#fff;color:#0b6b45">IGP</div><div><b style="color:#fff">Revolutionary Government of Zanzibar</b><span style="color:#cfe7da">Serikali ya Mapinduzi ya Zanzibar</span></div></div>
    <div><h1>Integrated Government</h1><p style="font-size:18px">Mifumo Zinasomana. Zanzibar Moja.</p>
    <p>Apply for government services online, pay by mobile money and track every step with one reference.</p>${PHASE_STRIP}</div>
    <div style="font-size:12px;opacity:.75"><a href="#/verify" style="color:#fff">Verify a government document</a> · <a href="#/phone" style="color:#fff">Sandbox handset</a></div></div>
    <div class="panel">${inner}</div></div>`;
}

route(/^\/login$/, async () => {
  if (S.me) { setTimeout(() => go('#/home')); return ''; }
  after(() => {
    document.getElementById('login').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      try { await api('/auth/login', { body: { username: f.get('username'), password: f.get('password') } }); await boot(); go('#/home'); }
      catch (ex) { const er = document.getElementById('err'); er.textContent = ex.message; er.style.display = ''; }
    };
  });
  return authLayout(h`<div class="card"><div class="card-b" style="padding:28px">
    <h1 style="margin-bottom:4px">Sign in</h1><p class="muted">Citizens, businesses and government officers</p>
    <form id="login" style="margin-top:16px"><label class="f"><span>Username</span><input name="username" autocomplete="username" required></label>
    <label class="f"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
    <div class="notice bad" id="err" style="display:none"></div><button class="btn primary" style="width:100%">Sign in</button></form>
    <p style="margin-top:16px;text-align:center">New applicant? <a href="#/register">Create an account with your ZanID</a></p></div></div>`);
}, { public: true, bare: true });

route(/^\/register$/, async () => {
  after(() => {
    const box = document.getElementById('reg');
    const step1 = box.querySelector('#s1'); const step2 = box.querySelector('#s2'); const er = box.querySelector('#err');
    let zan = '';
    step1.onsubmit = async (e) => {
      e.preventDefault(); er.style.display = 'none'; const f = new FormData(step1); zan = f.get('zan_id');
      try {
        const r = await api('/auth/register/start', { body: { zan_id: zan, dob: f.get('dob') } });
        step1.style.display = 'none'; step2.style.display = '';
        box.querySelector('#who').innerHTML = str(h`Hello <b>${r.full_name}</b>. We sent a 6-digit code to your registered phone ${r.phone_hint}.
          ${r.sandbox_code ? h`<br><span class="badge warn" style="margin-top:6px">SMS sandbox – code: ${r.sandbox_code}</span>` : ''}`);
      } catch (ex) { er.textContent = ex.message; er.style.display = ''; }
    };
    step2.onsubmit = async (e) => {
      e.preventDefault(); er.style.display = 'none'; const f = new FormData(step2);
      try { await api('/auth/register/complete', { body: { zan_id: zan, code: f.get('code'), username: f.get('username'), password: f.get('password') } }); await boot(); go('#/home'); }
      catch (ex) { er.textContent = ex.message; er.style.display = ''; }
    };
  });
  return authLayout(h`<div class="card" id="reg"><div class="card-b" style="padding:28px"><h1>Create your account</h1>
    <p class="muted">Your identity is confirmed against the civil registry.</p>
    <form id="s1" style="margin-top:16px"><label class="f"><span>ZanID number</span><input name="zan_id" required inputmode="numeric"></label>
      <label class="f"><span>Date of birth</span><input name="dob" type="date" required></label><button class="btn primary" style="width:100%">Continue</button></form>
    <form id="s2" style="display:none;margin-top:16px"><p id="who"></p><label class="f"><span>Verification code</span><input name="code" required inputmode="numeric" autocomplete="one-time-code"></label>
      <label class="f"><span>Choose a username</span><input name="username" required autocomplete="username"></label>
      <label class="f"><span>Choose a password</span><input name="password" type="password" required autocomplete="new-password"><div class="hint">At least 8 characters with letters and numbers</div></label>
      <button class="btn primary" style="width:100%">Create account</button></form>
    <div class="notice bad" id="err" style="display:none;margin-top:12px"></div>
    <p style="margin-top:16px;text-align:center"><a href="#/login">Back to sign in</a></p></div></div>`);
}, { public: true, bare: true });

route(/^\/verify(?:\/([A-Za-z0-9]+))?$/, async ({ params }) => {
  const code = params[0];
  let result = '';
  if (code) {
    try {
      const r = await api('/verify/' + encodeURIComponent(code));
      result = h`<div class="notice ${r.valid ? 'good' : 'bad'}" style="margin-top:16px"><h2>${r.valid ? '✓ Valid document' : r.revoked ? '✕ Revoked' : '✕ Expired'}</h2></div>
        ${dl([['Document', r.title], ['Number', r.number], ['Issued to', r.holder], r.business ? ['Business', r.business] : null, ['Issued by', r.agency], ['Issued on', fmtDate(r.issued_at)], ['Valid until', r.valid_until ? fmtDate(r.valid_until) : 'No expiry']])}`;
    } catch (e) { result = h`<div class="notice bad" style="margin-top:16px">✕ ${e.message}</div>`; }
  }
  after(() => { document.getElementById('vf').onsubmit = (e) => { e.preventDefault(); go('#/verify/' + new FormData(e.target).get('code').trim().toUpperCase()); }; });
  const inner = h`<div class="card"><div class="card-b" style="padding:28px"><h1>Verify a document</h1><p class="muted">Enter the verification code printed on the certificate.</p>
    <form id="vf" class="row" style="margin-top:12px;flex-wrap:nowrap"><input name="code" value="${code || ''}" placeholder="e.g. 3F9A1C0B22DE" required><button class="btn primary">Check</button></form>${result}
    ${S.me ? h`<p style="margin-top:16px"><a href="#/home">← Back</a></p>` : h`<p style="margin-top:16px"><a href="#/login">Sign in</a></p>`}</div></div>`;
  return authLayout(inner);
}, { public: true, bare: true });

// Sandbox handset: answers mobile money prompts sent to the sandbox providers
route(/^\/phone$/, async ({ query }) => {
  const m = query.msisdn || '';
  let prompts = [];
  if (m) { try { prompts = await api('/sandbox/prompts' + qs({ msisdn: m })); } catch (e) { toast(e.message, true); } }
  const waiting = prompts.find((p) => p.status === 'waiting');
  after(() => {
    const f = document.getElementById('num'); if (f) f.onsubmit = (e) => { e.preventDefault(); go('#/phone?msisdn=' + encodeURIComponent(new FormData(f).get('m'))); };
    const pf = document.getElementById('pin');
    if (pf) {
      const send = async (approve) => {
        try {
          const r = await api(`/sandbox/prompts/${waiting.id}/respond`, { body: { approve, pin: new FormData(pf).get('pin') } });
          toast(r.outcome === 'paid' ? `Payment confirmed. Receipt ${r.receipt}` : `Payment ${r.outcome}`); refresh();
        } catch (e) { toast(e.message, true); }
      };
      pf.onsubmit = (e) => { e.preventDefault(); send(true); };
      document.getElementById('decline').onclick = () => send(false);
    }
    if (m && !waiting) setTimeout(() => { if (location.hash.startsWith('#/phone')) refresh(); }, 3000);
  });
  return h`<div style="min-height:100vh;display:grid;place-items:center;padding:20px;background:var(--bg)"><div>
    <p class="muted" style="text-align:center;max-width:300px;margin:0 auto 12px">Sandbox mobile network – this handset receives payment prompts for providers in <b>sandbox</b> mode and sends a signed callback, exactly like a live provider.</p>
    <div class="phone">${!m ? h`<div class="scr">Enter the phone number used for payment</div><form id="num"><input name="m" placeholder="0777 123 456" style="letter-spacing:0;font-size:15px"><button class="btn primary" style="width:100%;margin-top:10px">Open handset</button></form>`
    : waiting ? h`<div class="scr"><b>${waiting.provider_name}</b><br><br>Pay TZS ${Number(waiting.amount).toLocaleString()} to<br>SMZ GOVERNMENT<br>Control no. ${waiting.control_number}<br><br>Enter PIN to confirm</div>
        <form id="pin"><input name="pin" type="password" inputmode="numeric" maxlength="4" placeholder="••••" autocomplete="off"><button class="btn primary" style="width:100%;margin-top:10px">Confirm</button>
        <button type="button" class="btn" id="decline" style="width:100%;margin-top:8px">Cancel</button></form>`
      : h`<div class="scr">+${m.replace(/\D/g, '')}<br><br>No pending requests.<br><span style="opacity:.6">Waiting for prompts…</span></div>
        ${prompts.slice(0, 4).map((p) => h`<div class="scr" style="font-size:12px">${p.provider_name}: TZS ${Number(p.amount).toLocaleString()} – ${p.status}<br>${p.control_number}</div>`)}`}
    </div><p style="text-align:center;margin-top:12px"><a href="#/phone">Change number</a> · <a href="${S.me ? '#/home' : '#/login'}">Back to portal</a></p></div></div>`;
}, { public: true, bare: true });

// ================= account =================
route(/^\/account$/, async () => {
  after(() => {
    document.getElementById('pw').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      try { await api('/auth/password', { body: { current: f.get('current'), password: f.get('password') } }); toast('Password changed'); e.target.reset(); } catch (ex) { toast(ex.message, true); }
    };
  });
  const u = S.me;
  return h`<div class="page-head"><div><h1>Account</h1></div></div><div class="grid g2">
    ${card('Profile', dl([['Name', u.full_name], ['Username', u.username], ['Role', u.role_label], u.agency_name ? ['Agency', u.agency_name] : null, u.person ? ['ZanID', u.person.zan_id] : null, u.person ? ['Registered phone', u.person.phone] : null]))}
    ${card('Change password', h`<form id="pw"><label class="f"><span>Current password</span><input type="password" name="current" required autocomplete="current-password"></label>
      <label class="f"><span>New password</span><input type="password" name="password" required autocomplete="new-password"></label><button class="btn primary">Update password</button></form>`)}</div>`;
});

// ================= home (dispatch by role) =================
route(/^\/(?:home)?$/, async (ctx) => {
  const r = S.me.role;
  if (r === 'citizen') return citizenHome(ctx);
  if (['front_office', 'back_office'].includes(r)) return staffHome(ctx);
  if (r === 'finance') return financeHome(ctx);
  if (r === 'admin') return adminHome(ctx);
  if (['ministry_leader', 'security', 'executive'].includes(r)) { if (S.sip) { setTimeout(() => go('#/sip')); return ''; } return h`<div class="notice warn">SIP starts after all three IGP integration phases are live.</div>`; }
  return '';
});

// ================= applicant portal =================
async function citizenHome() {
  const [apps, notes] = await Promise.all([api('/applications'), api('/notifications')]);
  const action = apps.filter((a) => ['awaiting_applicant', 'awaiting_payment'].includes(a.status) || (a.payment_status && a.payment_status !== 'paid' && ['in_review', 'submitted', 'approved'].includes(a.status) && false));
  const open = apps.filter((a) => !['issued', 'rejected', 'withdrawn'].includes(a.status));
  after(() => { document.getElementById('track').onsubmit = (e) => { e.preventDefault(); const ref = new FormData(e.target).get('ref').trim(); const a = apps.find((x) => x.reference.toLowerCase() === ref.toLowerCase()); if (a) go('#/app/' + a.id); else toast('No application of yours has that reference', true); }; });
  return h`<div class="page-head"><div><h1>Karibu, ${S.me.full_name.split(' ')[0]}</h1><p>Apply, pay and track your government services in one place.</p></div>
    <a class="btn primary" href="#/services">＋ Apply for a service</a></div>
    ${action.length ? h`<div class="stack" style="margin-bottom:16px">${action.map((a) => h`<div class="notice warn row"><div><b>${a.reference}</b> · ${a.service}${a.business ? ' – ' + a.business : ''}<br>${a.status === 'awaiting_applicant' ? 'The office has asked for a document.' : 'Your application is approved. Pay the fee to receive your document.'}</div><div class="spacer"></div><a class="btn small primary" href="#/app/${a.id}">${a.status === 'awaiting_applicant' ? 'Upload document' : 'Pay now'}</a></div>`)}</div>` : ''}
    <div class="grid g3" style="margin-bottom:16px">${statTile('Open applications', open.length)}${statTile('Completed', apps.filter((a) => a.status === 'issued').length)}
      ${card('', h`<form id="track"><label class="f" style="margin:0"><span>Track by reference</span><div class="row" style="flex-wrap:nowrap"><input name="ref" placeholder="ZNZ-2026-123456"><button class="btn">Track</button></div></label></form>`)}</div>
    <div class="split">${card('My applications', appsTable(apps.slice(0, 8), true), h`<a href="#/applications">View all</a>`)}
      ${card('Messages', notes.length ? h`<ul class="timeline">${notes.slice(0, 6).map((n) => h`<li><div>${n.message}</div><small>${ago(n.created_at)}</small></li>`)}</ul>` : empty('No messages yet'), h`<a href="#/notifications">All</a>`)}</div>`;
}

function appsTable(apps, citizen = false) {
  if (!apps.length) return empty('No applications yet');
  return h`<div class="table-wrap"><table class="t"><tr><th>Reference</th><th>Service</th>${citizen ? '' : h`<th>Applicant</th>`}<th>Status</th><th>Payment</th><th>${citizen ? 'Updated' : 'Age'}</th></tr>
    ${apps.map((a) => h`<tr class="click" data-href="#/app/${a.id}"><td><a href="#/app/${a.id}" class="mono">${a.reference}</a>${a.escalated ? h` <span class="badge bad">Escalated</span>` : ''}</td>
      <td>${a.service}${a.business ? h`<br><small>${a.business}</small>` : ''}${!citizen && a.agency ? '' : ''}</td>${citizen ? '' : h`<td>${a.applicant}${a.channel === 'desk' ? h`<br><small>Service desk</small>` : ''}</td>`}
      <td>${statusBadge(a.status)}${a.open_referrals ? h`<br><small>${a.open_referrals} referral(s) open</small>` : ''}</td><td>${payBadge(a.payment_status)}</td>
      <td>${citizen ? ago(a.updated_at) : h`<span class="${a.age_days > a.sla_days && !['issued', 'rejected', 'withdrawn'].includes(a.status) ? 'badge bad' : ''}">${a.age_days} d</span><br><small>standard ${a.sla_days} d</small>`}</td></tr>`)}</table></div>`;
}

route(/^\/applications$/, async () => {
  const apps = await api('/applications');
  return h`<div class="page-head"><div><h1>My applications</h1><p>Every application keeps one tracking reference from submission to issuance.</p></div><a class="btn primary" href="#/services">＋ New application</a></div>${card('', appsTable(apps, true))}`;
}, { roles: ['citizen'] });

route(/^\/notifications$/, async () => {
  const notes = await api('/notifications'); api('/notifications/read', { method: 'POST' }).catch(() => {});
  return h`<div class="page-head"><div><h1>Messages</h1><p>Also sent to your registered phone by SMS.</p></div></div>
    ${card('', notes.length ? h`<ul class="timeline">${notes.map((n) => h`<li><div>${n.message}</div><small>${fmtDateTime(n.created_at)}${n.application_id ? h` · <a href="#/app/${n.application_id}">Open application</a>` : ''}</small></li>`)}</ul>` : empty('No messages'))}`;
}, { roles: ['citizen'] });

route(/^\/records$/, async () => {
  const r = await api('/me/records');
  const p = r.profile;
  return h`<div class="page-head"><div><h1>My verified records</h1><p>Records held by government offices. Offices you apply to reuse them, so you are not asked for the same documents twice.</p></div></div>
    <div class="split">${card('Records', r.records.length ? h`<div class="table-wrap"><table class="t"><tr><th>Record</th><th>Number</th><th>Issued by</th><th>Valid until</th><th></th></tr>
      ${r.records.map((x) => h`<tr><td>${x.type_name}${x.data && x.data.name ? h`<br><small>${x.data.name}</small>` : ''}</td><td class="mono">${x.number || '—'}</td><td>${x.issuing_agency}</td><td>${x.valid_until ? fmtDate(x.valid_until) : '—'}</td><td>${x.valid ? h`<span class="badge good">✓ Valid</span>` : h`<span class="badge bad">Not valid</span>`}</td></tr>`)}</table></div>` : empty('No records'))}
    <div class="stack">${card('Civil registry', dl([['Name', p.full_name], ['ZanID', p.zan_id], ['Date of birth', fmtDate(p.dob)], ['Phone', p.phone], ['Address', p.address]]))}
      ${card('My businesses', p.businesses.length ? h`<ul class="doclist">${p.businesses.map((b) => h`<li><div><b>${b.name}</b><br><small>BRN ${b.brn} · TIN ${b.tin}</small></div></li>`)}</ul>` : empty('None registered'))}</div></div>`;
}, { roles: ['citizen'] });

route(/^\/services$/, async () => {
  const svcs = await api('/services');
  const by = {}; for (const s of svcs) (by[s.agency] = by[s.agency] || []).push(s);
  return h`<div class="page-head"><div><h1>Government services</h1><p>Choose a service to apply online. Need help? Visit any government service desk.</p></div></div>
    <div class="stack">${Object.entries(by).map(([ag, list]) => card(ag, h`<div class="grid g2">${list.map((s) => h`<div class="card" style="box-shadow:none"><div class="card-b">
      <div class="row"><h3>${s.name}</h3><div class="spacer"></div>${s.origin === 'digitized' ? h`<span class="badge info">Newly digitized</span>` : h`<span class="badge">Integrated</span>`}</div>
      <p class="t2" style="margin:6px 0 10px">${s.description}</p><div class="row"><small>Fee <b>${s.fee ? money(s.fee) : 'Free'}</b> · Service standard ${s.sla_days} days</small><div class="spacer"></div>
      <a class="btn small primary" href="#/apply/${s.id}">Apply</a></div></div></div>`)}</div>`))}</div>`;
}, { roles: ['citizen'] });

// shared application form (citizen online or front office assisted)
async function applicationForm({ serviceId, person, businessId, desk = false }) {
  const svc = await api(`/services/${serviceId}${qs({ person_id: desk ? person.id : undefined, business_id: businessId })}`);
  const needBiz = svc.subject === 'business';
  const businesses = person.businesses || [];
  if (needBiz && !businessId) {
    if (!businesses.length) return h`<div class="notice warn">${svc.name} is issued to a registered business. ${desk ? 'This person' : 'You'} have no business registered with BPRA.</div>`;
    return card(`${svc.name} – choose the business`, h`<ul class="doclist">${businesses.map((b) => h`<li><div><b>${b.name}</b><br><small>BRN ${b.brn}</small></div><div class="spacer"></div>
      <a class="btn small primary" href="${desk ? `#/desk?zan=${person.zan_id}&service=${svc.id}&business=${b.id}` : `#/apply/${svc.id}?business=${b.id}`}">Select</a></li>`)}</ul>`);
  }
  const docs = svc.resolved_docs || [];
  const pre = svc.prefill || {};
  const field = (f) => {
    const v = pre[f.name] || '';
    const req = f.required ? 'required' : '';
    let input;
    if (f.type === 'select') input = h`<select name="f_${f.name}" ${raw(req)}><option value="">Choose…</option>${f.options.map((o) => h`<option ${o === v ? raw('selected') : ''}>${o}</option>`)}</select>`;
    else if (f.type === 'textarea') input = h`<textarea name="f_${f.name}" ${raw(req)}>${v}</textarea>`;
    else input = h`<input name="f_${f.name}" type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}" value="${v}" ${raw(req)}>`;
    return h`<label class="f"><span>${f.label}${f.required ? '' : h` <small>(optional)</small>`}</span>${input}${f.prefill && v ? h`<div class="hint">✓ Pre-filled from verified records</div>` : ''}</label>`;
  };
  after(() => {
    document.getElementById('apform').onsubmit = async (e) => {
      e.preventDefault();
      const form = e.target; const fd = new FormData(form); const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      const payload = { service_id: svc.id, business_id: businessId || undefined, form: {}, zan_id: desk ? person.zan_id : undefined };
      for (const [k, v] of fd.entries()) if (k.startsWith('f_')) payload.form[k.slice(2)] = v;
      const out = new FormData(); out.append('payload', JSON.stringify(payload));
      for (const el of form.querySelectorAll('input[type=file]')) if (el.files[0]) out.append(el.name, el.files[0]);
      try { const r = await api('/applications', { form: out }); toast(`Submitted. Reference ${r.reference}`); go('#/app/' + r.id); }
      catch (ex) { toast(ex.message, true); btn.disabled = false; }
    };
  });
  const reused = docs.filter((d) => d.satisfied_by_record);
  const toUpload = docs.filter((d) => !d.satisfied_by_record);
  const biz = businesses.find((b) => b.id === Number(businessId));
  return h`<form id="apform"><div class="split"><div class="stack">
    ${card(`${svc.name}${biz ? ' – ' + biz.name : ''}`, h`<p class="t2">${svc.description}</p>${svc.form_schema.map(field)}`)}
    ${toUpload.length ? card('Documents to upload', h`<p class="muted">PDF, JPG or PNG, up to 10 MB each. If you don’t have one now, you can upload it later.</p>
      ${toUpload.map((d) => h`<label class="f"><span>${d.label}</span><input type="file" name="doc_${d.code}" accept=".pdf,.jpg,.jpeg,.png"></label>`)}`) : ''}</div>
    <div class="stack">${card('Reused verified records', reused.length ? h`<ul class="doclist">${reused.map((d) => h`<li><span class="badge good">✓</span><div>${d.label}<br><small>${d.satisfied_by_record.issuing_agency} · ${d.satisfied_by_record.number || ''}</small></div></li>`)}</ul>
      <p class="hint" style="margin-top:8px">Shared securely between government offices – no need to submit copies.</p>` : empty('None available for this service'))}
    ${card('Summary', h`${dl([['Applicant', person.full_name], ['ZanID', person.zan_id], ['Responsible office', svc.agency], ['Fee', svc.fee ? money(svc.fee) : 'Free'], ['Service standard', `${svc.sla_days} days`], ['Channel', desk ? 'Service desk (assisted)' : 'Online']])}
      <button class="btn primary" type="submit" style="width:100%;margin-top:14px">Submit application</button>`)}</div></div></form>`;
}

route(/^\/apply\/(\d+)$/, async ({ params, query }) => {
  const form = await applicationForm({ serviceId: params[0], person: S.me.person, businessId: query.business });
  return h`<div class="page-head"><div><a href="#/services">← Services</a><h1 style="margin-top:6px">New application</h1></div></div>${form}`;
}, { roles: ['citizen'] });

// ================= shared case view =================
function progress(a) {
  const routed = a.events.some((e) => e.kind === 'routed') || ['in_review', 'awaiting_payment', 'approved', 'issued'].includes(a.status);
  const reviewed = ['awaiting_payment', 'approved', 'issued'].includes(a.status);
  const paid = !a.payment || a.payment.status === 'paid';
  const steps = [['Submitted', true], ['Checked', routed], ['Reviewed', reviewed], [a.payment ? 'Paid' : 'No fee', paid && (reviewed || (a.payment && a.payment.status === 'paid'))], ['Issued', a.status === 'issued']];
  const nowIdx = steps.findIndex((s) => !s[1]);
  return h`<div class="steps">${steps.map(([l, d], i) => h`<div class="${d ? 'done' : i === nowIdx && !['rejected', 'withdrawn'].includes(a.status) ? 'now' : ''}">${l}</div>`)}</div>`;
}

function docsPanel(a, staff) {
  const reqDocs = a.required_docs.map((d) => {
    const st = d.satisfied_by_record ? h`<span class="badge good">✓ Verified record</span>` : d.uploaded ? h`<span class="badge info">Uploaded</span>` : h`<span class="badge warn">Missing</span>`;
    return h`<li><div style="flex:1;min-width:180px">${d.label}${d.satisfied_by_record ? h`<br><small>${d.satisfied_by_record.issuing_agency} · ${d.satisfied_by_record.number || ''}</small>` : ''}</div>${st}</li>`;
  });
  const files = a.documents.map((d) => h`<li><div style="flex:1;min-width:180px"><a href="/api/documents/${d.id}/download" target="_blank" rel="noopener">${d.filename}</a><br><small>${(a.required_docs.find((x) => x.code === d.doc_code) || {}).label || d.doc_code} · ${Math.round(d.size / 1024)} KB · ${fmtDate(d.created_at)}</small></div>
    ${d.status === 'accepted' ? h`<span class="badge good">Accepted</span>` : d.status === 'rejected' ? h`<span class="badge bad">Rejected</span>` : h`<span class="badge">Pending check</span>`}
    ${staff && S.me.agency_id === a.service_agency_id && ['front_office', 'back_office'].includes(S.me.role) && d.status === 'pending' ? h`<button class="btn small" data-doc-ok="${d.id}">Accept</button><button class="btn small danger" data-doc-no="${d.id}">Reject</button>` : ''}</li>`);
  return card('Documents', h`<h3 style="margin-bottom:4px">Required</h3><ul class="doclist">${reqDocs}</ul>
    <h3 style="margin:14px 0 4px">Uploaded files</h3>${files.length ? h`<ul class="doclist">${files}</ul>` : h`<p class="muted">None</p>`}`);
}

function paymentPanel(a, isApplicant) {
  const p = a.payment;
  if (!p) return card('Fee', h`<p class="muted">No fee for this service.</p>`);
  let body = dl([['Amount', money(p.amount)], ['Control number', h`<span class="mono">${p.control_number}</span>`], ['Status', payBadge(p.status)],
    p.status === 'paid' ? ['Receipt', h`<a href="/api/payments/${p.id}/receipt" target="_blank">${p.receipt_no}</a>`] : null,
    p.status === 'paid' ? ['Paid', `${fmtDateTime(p.paid_at)}${p.msisdn ? ' from +' + p.msisdn : ''}`] : null,
    !isApplicant && p.status === 'paid' ? ['Reconciled', p.reconciled ? h`<span class="badge good">✓ Reconciled</span>` : h`<span class="badge">Not yet</span>`] : null]);
  const canPay = (isApplicant || (S.me.role === 'front_office' && S.me.agency_id === a.service_agency_id)) && p.status !== 'paid' && !['rejected', 'withdrawn'].includes(a.status);
  if (p.status === 'pending') body = h`${body}<div class="notice warn" style="margin-top:12px">Waiting for confirmation on +${p.msisdn}. Approve the prompt on the phone. <a href="#/phone?msisdn=${p.msisdn}" target="_blank">Open sandbox handset</a></div>`;
  if (canPay && S.phases.phase2 && S.phases.phase2.live) body = h`${body}<button class="btn primary" data-pay style="width:100%;margin-top:12px">${p.status === 'pending' || p.status === 'failed' ? 'Try again' : 'Pay with mobile money'}</button>`;
  else if (canPay) body = h`${body}<div class="notice" style="margin-top:12px">Pay at a government cashier with the control number.</div>`;
  return card('Fee', body);
}

route(/^\/app\/(\d+)$/, async ({ params }) => {
  const a = await api('/applications/' + params[0]);
  const me = S.me; const staff = me.role !== 'citizen';
  const isApplicant = me.role === 'citizen';
  const owning = me.agency_id === a.service_agency_id;
  const openReqs = a.requests.filter((r) => r.status === 'open');
  const isOpen = ['submitted', 'awaiting_applicant', 'in_review', 'awaiting_payment', 'approved'].includes(a.status);
  const myReferrals = a.referrals.filter((r) => r.to_agency_id === me.agency_id && r.status === 'open');

  // ---- actions ----
  const acts = [];
  if (owning && ['front_office', 'back_office'].includes(me.role) && ['submitted', 'in_review', 'awaiting_applicant'].includes(a.status)) acts.push(h`<button class="btn" data-act="request">Request document</button>`);
  if (owning && ['front_office', 'back_office'].includes(me.role) && a.status === 'submitted') acts.push(h`<button class="btn primary" data-act="route">Check &amp; route for review</button>`);
  if (owning && me.role === 'back_office' && ['in_review', 'submitted'].includes(a.status)) acts.push(h`<button class="btn" data-act="refer">Refer to another office</button>`);
  if (owning && me.role === 'back_office' && a.status === 'in_review') acts.push(h`<button class="btn primary" data-act="approve">Approve</button>`);
  if (owning && me.role === 'back_office' && a.status === 'approved') acts.push(h`<button class="btn primary" data-act="issue">Issue ${a.output_name || 'document'}</button>`);
  if (owning && me.role === 'back_office' && isOpen) acts.push(h`<button class="btn danger" data-act="reject">Reject</button>`);
  if (owning && ['front_office', 'back_office', 'ministry_leader'].includes(me.role) && isOpen) acts.push(h`<button class="btn" data-act="assign">Assign</button>`);
  if (owning && ['ministry_leader', 'back_office'].includes(me.role) && isOpen && !a.escalated) acts.push(h`<button class="btn" data-act="escalate">Escalate</button>`);
  if (isApplicant && ['submitted', 'awaiting_applicant', 'in_review'].includes(a.status)) acts.push(h`<button class="btn danger" data-act="withdraw">Withdraw</button>`);

  after(() => wireCase(a));
  if (a.payment && a.payment.status === 'pending') pollPayment(a.id);

  const left = [];
  if (isApplicant && openReqs.length) {
    left.push(h`<section class="card" style="border-color:var(--warn)"><div class="card-h"><h2>Action needed</h2></div><div class="card-b">${openReqs.map((r) => h`<form class="upl" data-code="${r.doc_code}" data-label="${r.label}" style="margin-bottom:12px">
      <p><b>${r.label}</b>${r.message ? h` – ${r.message}` : ''}<br><small>Requested ${fmtDateTime(r.created_at)}</small></p><div class="row" style="flex-wrap:nowrap"><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png" required><button class="btn primary">Upload</button></div></form>`)}</div></section>`);
  }
  if (a.issued) {
    left.push(h`<div class="notice good row"><div><b>${a.issued.title} ${a.issued.number}</b><br>Issued ${fmtDate(a.issued.issued_at)}${a.issued.valid_until ? ' · valid until ' + fmtDate(a.issued.valid_until) : ''} · verification code <span class="mono">${a.issued.verification_code}</span></div><div class="spacer"></div>
      <a class="btn primary" href="/api/applications/${a.id}/certificate" target="_blank">Download</a></div>`);
  }
  if (a.status === 'rejected') left.push(h`<div class="notice bad"><b>Not approved.</b> ${a.decision_note}</div>`);
  if (staff && myReferrals.length) {
    left.push(h`<section class="card" style="border-color:var(--accent)"><div class="card-h"><h2>Referral to your office</h2></div><div class="card-b">${myReferrals.map((r) => h`<p><b>From ${r.from_agency}:</b> ${r.question}</p>
      <div class="row"><button class="btn primary" data-ref-answer="${r.id}" data-outcome="cleared">Clear</button><button class="btn danger" data-ref-answer="${r.id}" data-outcome="objection">Raise objection</button></div>`)}</div></section>`);
  }
  left.push(card('Application details', h`${dl([['Service', a.service_name], ['Responsible office', a.agency_name], ['Applicant', `${a.applicant_name} (ZanID ${a.zan_id})`],
    a.business_name ? ['Business', `${a.business_name} (BRN ${a.brn})`] : null, ['Channel', a.channel === 'desk' ? 'Service desk (assisted)' : 'Online'],
    ['Submitted', fmtDateTime(a.created_at)], ['Service standard', `${a.sla_days} days – due ${fmtDate(a.sla_due)}`],
    staff ? ['Assigned to', a.assignee ? a.assignee.full_name : 'Unassigned'] : null,
    ...Object.entries(a.form_data).map(([k, v]) => [k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), String(v)])])}`));
  left.push(docsPanel(a, staff));
  if (isApplicant && isOpen && !openReqs.length) {
    left.push(card('Add a document', h`<form class="upl" data-code="other" data-label="Additional document"><div class="row" style="flex-wrap:nowrap"><select name="code" style="max-width:240px">${a.required_docs.filter((d) => !d.satisfied_by_record).map((d) => h`<option value="${d.code}">${d.label}</option>`)}<option value="other">Other</option></select>
      <input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png" required><button class="btn">Upload</button></div></form>`));
  }
  if (staff) {
    left.push(card('Verified records available to your office', a.verified_records.length ? h`<div class="table-wrap"><table class="t"><tr><th>Record</th><th>Number</th><th>Issued by</th><th>Status</th></tr>
      ${a.verified_records.map((r) => h`<tr><td>${r.type_name}</td><td class="mono">${r.number || '—'}</td><td>${r.issuing_agency}</td><td>${r.valid ? h`<span class="badge good">✓ Valid</span>` : h`<span class="badge bad">Not valid</span>`}</td></tr>`)}</table></div>` : empty('No records shared with your office')));
  }

  const right = [];
  right.push(paymentPanel(a, isApplicant));
  if (a.referrals.length || staff) {
    right.push(card('Referrals', a.referrals.length ? h`<ul class="doclist">${a.referrals.map((r) => h`<li><div style="flex:1"><b>${r.to_agency}</b>${staff && r.question ? h`<br><small>${r.question}</small>` : ''}${r.note ? h`<br><small>“${r.note}”</small>` : ''}</div>
      ${r.status === 'open' ? h`<span class="badge warn">Awaiting</span>` : r.outcome === 'cleared' ? h`<span class="badge good">✓ Cleared</span>` : h`<span class="badge bad">Objection</span>`}</li>`)}</ul>` : h`<p class="muted">No referrals.</p>`));
  }
  if (a.requests.length) right.push(card('Document requests', h`<ul class="doclist">${a.requests.map((r) => h`<li><div style="flex:1">${r.label}<br><small>${fmtDate(r.created_at)}</small></div>${r.status === 'open' ? h`<span class="badge warn">Open</span>` : h`<span class="badge good">Received</span>`}</li>`)}</ul>`));
  right.push(card('Progress', h`<ul class="timeline">${a.events.map((e) => h`<li class="${e.visible_to_applicant ? '' : 'internal'}"><div>${e.message}</div><small>${fmtDateTime(e.created_at)}${staff && e.actor_name ? ' · ' + e.actor_name : ''}${staff && !e.visible_to_applicant ? ' · internal' : ''}</small></li>`)}</ul>
    ${staff ? h`<form id="note" class="row" style="flex-wrap:nowrap;margin-top:8px"><input name="text" placeholder="Add an internal note"><button class="btn small">Add</button></form>` : ''}`));

  return h`<div class="page-head"><div><a href="${isApplicant ? '#/applications' : '#/queue'}">← Back</a>
    <h1 style="margin-top:6px"><span class="mono" style="font-size:20px">${a.reference}</span> ${statusBadge(a.status)} ${a.escalated && staff ? h`<span class="badge bad">Escalated</span>` : ''}</h1>
    <p>${a.service_name}${a.business_name ? ' – ' + a.business_name : ''} · ${a.status_label}</p></div><div class="row">${acts}</div></div>
    ${card('', progress(a))}<div class="split" style="margin-top:16px"><div class="stack">${left}</div><div class="stack">${right}</div></div>`;
});

let pollTimer = null;
function pollPayment(id) {
  clearTimeout(pollTimer);
  let n = 0;
  const tick = async () => {
    if (location.hash !== '#/app/' + id || n++ > 90) return;
    try { const a = await api('/applications/' + id); if (a.payment && a.payment.status !== 'pending') { toast(a.payment.status === 'paid' ? 'Payment received' : 'Payment was not completed', a.payment.status !== 'paid'); return refresh(); } } catch {}
    pollTimer = setTimeout(tick, 2000);
  };
  pollTimer = setTimeout(tick, 2000);
}

async function loadProviders() { if (!S.providers) S.providers = await api('/payments/providers'); return S.providers; }

function wireCase(a) {
  const id = a.id; const post = (p, body) => api(`/applications/${id}/${p}`, { body: body || {} });
  document.querySelectorAll('form.upl').forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault(); const fd = new FormData(f); const out = new FormData();
      const code = fd.get('code') || f.dataset.code; out.append('doc_code', code); out.append('label', f.dataset.label); out.append('file', fd.get('file'));
      try { await api(`/applications/${id}/documents`, { form: out }); toast('Document uploaded'); refresh(); } catch (ex) { toast(ex.message, true); }
    };
  });
  const note = document.getElementById('note');
  if (note) note.onsubmit = async (e) => { e.preventDefault(); try { await post('note', { text: new FormData(note).get('text') }); refresh(); } catch (ex) { toast(ex.message, true); } };
  document.querySelectorAll('[data-doc-ok],[data-doc-no]').forEach((b) => {
    b.onclick = async () => {
      const ok = !!b.dataset.docOk; let note2 = '';
      if (!ok) { const v = await modal('Reject document', h`<label class="f"><span>Reason (shown to applicant)</span><input name="note" required></label>`, { submit: 'Reject', danger: true }); if (!v) return; note2 = v.note; }
      try { await api(`/documents/${b.dataset.docOk || b.dataset.docNo}/review`, { body: { status: ok ? 'accepted' : 'rejected', note: note2 } }); refresh(); } catch (ex) { toast(ex.message, true); }
    };
  });
  document.querySelectorAll('[data-ref-answer]').forEach((b) => {
    b.onclick = async () => {
      const obj = b.dataset.outcome === 'objection';
      await modalAction(obj ? 'Raise objection' : 'Clear referral', h`<label class="f"><span>${obj ? 'Reason for objection' : 'Note (optional)'}</span><textarea name="note" ${raw(obj ? 'required' : '')}></textarea></label>`,
        async (v) => { await api(`/referrals/${b.dataset.refAnswer}/answer`, { body: { outcome: b.dataset.outcome, note: v.note } }); toast('Response sent'); refresh(); }, { submit: obj ? 'Send objection' : 'Clear', danger: obj });
    };
  });
  const pay = document.querySelector('[data-pay]');
  if (pay) pay.onclick = async () => {
    const provs = await loadProviders();
    const r = await modalAction('Pay with mobile money', h`<p>Amount <b>${money(a.payment.amount)}</b> · control number <span class="mono">${a.payment.control_number}</span></p>
      <label class="f"><span>Provider</span><select name="provider" required>${provs.map((p) => h`<option value="${p.code}">${p.name}${p.mode === 'sandbox' ? ' (sandbox)' : ''}</option>`)}</select></label>
      <label class="f"><span>Mobile number</span><input name="msisdn" value="${S.me.person ? S.me.person.phone : a.applicant_phone || ''}" required inputmode="tel"><div class="hint">You will receive a prompt on this phone to enter your PIN.</div></label>`,
    (v) => post('pay', { provider: v.provider, msisdn: v.msisdn }), { submit: 'Send payment request' });
    if (r) { toast(`Request sent to +${r.msisdn}. Confirm on the phone.`); refresh(); }
  };
  document.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.act; let ok = null;
      if (act === 'request') {
        const opts = a.required_docs.filter((d) => !d.satisfied_by_record);
        ok = await modalAction('Request a document', h`<label class="f"><span>Document</span><select name="doc">${opts.map((d) => h`<option value="${d.code}|${d.label}">${d.label}${d.uploaded ? ' (re-submit)' : ' (missing)'}</option>`)}<option value="other|Other supporting document">Other supporting document</option></select></label>
          <label class="f"><span>Message to applicant</span><textarea name="message" placeholder="What exactly is needed"></textarea></label>`,
        (v) => { const [code, label] = v.doc.split('|'); return post('request-document', { doc_code: code, label, message: v.message }); }, { submit: 'Send request' });
      } else if (act === 'route' || act === 'assign') {
        const staff = (await api('/staff')).filter((s) => s.role === 'back_office');
        ok = await modalAction(act === 'route' ? 'Route for review' : 'Assign case', h`${act === 'route' ? h`<p>Confirms the submission is complete. Standard referrals (${a.referral_agencies.join(', ') || 'none'}) are sent automatically.</p>` : ''}
          <label class="f"><span>Back office officer</span><select name="assign_to"><option value="">${act === 'route' ? 'Leave unassigned' : 'Choose…'}</option>${staff.map((s) => h`<option value="${s.id}">${s.full_name}</option>`)}</select></label>
          ${act === 'route' ? h`<label class="f"><span>Note (optional)</span><input name="note"></label>` : ''}`,
        (v) => (act === 'route' ? post('route', { assign_to: v.assign_to ? Number(v.assign_to) : null, note: v.note }) : post('assign', { user_id: Number(v.assign_to) })), { submit: act === 'route' ? 'Route' : 'Assign' });
      } else if (act === 'refer') {
        const ags = (await api('/agencies')).filter((x) => x.id !== a.service_agency_id);
        ok = await modalAction('Refer to another office', h`<label class="f"><span>Office</span><select name="to">${ags.map((x) => h`<option value="${x.id}">${x.name}</option>`)}</select></label>
          <label class="f"><span>What do you need from them?</span><textarea name="question" required></textarea></label>`, (v) => post('refer', { to_agency_id: Number(v.to), question: v.question }), { submit: 'Send referral' });
      } else if (act === 'approve') {
        const obj = a.referrals.some((r) => r.outcome === 'objection');
        ok = await modalAction('Approve application', h`${a.payment && a.payment.status !== 'paid' ? h`<div class="notice warn">Fee not yet paid. The applicant will be asked to pay ${money(a.payment.amount)}.</div>` : ''}
          ${obj ? h`<div class="notice bad">A referral raised an objection. Record how it was resolved.</div>` : ''}<label class="f"><span>Decision note ${obj ? '' : '(optional)'}</span><textarea name="note" ${raw(obj ? 'required' : '')}></textarea></label>`, (v) => post('approve', { note: v.note }), { submit: 'Approve' });
      } else if (act === 'reject') {
        ok = await modalAction('Reject application', h`<label class="f"><span>Reason (sent to applicant)</span><textarea name="note" required></textarea></label>`, (v) => post('reject', { note: v.note }), { submit: 'Reject', danger: true });
      } else if (act === 'issue') {
        ok = await modalAction(`Issue ${a.output_name}`, h`<p>The ${a.output_name} will be issued under reference <b>${a.reference}</b> and published as a verified record for other offices.</p>`, () => post('issue'), { submit: 'Issue' });
      } else if (act === 'escalate') {
        ok = await modalAction('Escalate for executive attention', h`<label class="f"><span>Reason</span><textarea name="reason" required></textarea></label>`, (v) => post('escalate', { reason: v.reason }), { submit: 'Escalate' });
      } else if (act === 'withdraw') {
        ok = await modalAction('Withdraw application', h`<p>This cannot be undone.</p>`, () => post('withdraw'), { submit: 'Withdraw', danger: true });
      }
      if (ok) { toast('Done'); refresh(); }
    };
  });
}
