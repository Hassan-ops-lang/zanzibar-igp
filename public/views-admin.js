/* System administration */
'use strict';

async function adminHome() {
  const [ph, svcs, users, chain] = await Promise.all([api('/admin/phases'), api('/admin/services'), api('/admin/users'), api('/admin/audit/verify')]);
  return h`<div class="page-head"><div><h1>Administration</h1><p>Configure services, integrations, users and rollout.</p></div></div>
    <div class="grid g4" style="margin-bottom:16px">${statTile('Services', svcs.filter((s) => s.active).length, `${svcs.filter((s) => s.origin === 'digitized').length} digitized from manual`)}
      ${statTile('Staff accounts', users.filter((u) => u.role !== 'citizen').length)}${statTile('Citizen accounts', users.filter((u) => u.role === 'citizen').length)}
      ${statTile('Audit log', chain.total, chain.ok ? '✓ hash chain intact' : `✕ chain broken at #${chain.brokenAt}`)}</div>
    ${card('Rollout', rolloutTable(ph, false), h`<a href="#/admin/rollout">Manage</a>`)}`;
}
function rolloutTable(ph, editable) {
  return h`<table class="t">${Object.entries(ph).map(([k, p]) => h`<tr><td><b>${p.label}</b></td><td>${p.live ? h`<span class="badge good">✓ Live</span>` : h`<span class="badge">Not live</span>`}</td>
    ${editable ? h`<td style="text-align:right"><button class="btn small" data-phase="${k}" data-live="${p.live ? '0' : '1'}">${p.live ? 'Switch off' : 'Go live'}</button></td>` : ''}</tr>`)}
    <tr><td><b>SIP – Sovereign Intelligence Platform</b><br><small>Starts automatically when phases 1–3 are live</small></td><td>${['phase1', 'phase2', 'phase3'].every((k) => ph[k] && ph[k].live) ? h`<span class="badge good">✓ Active</span>` : h`<span class="badge">Waiting</span>`}</td>${editable ? h`<td></td>` : ''}</tr></table>`;
}

route(/^\/admin\/rollout$/, async () => {
  const ph = await api('/admin/phases');
  after(() => document.querySelectorAll('[data-phase]').forEach((b) => { b.onclick = async () => { await api('/admin/phases', { method: 'PUT', body: { [b.dataset.phase]: b.dataset.live === '1' } }); await boot(); document.getElementById('app').innerHTML = ''; refresh(); }; }));
  return h`<div class="page-head"><div><h1>Rollout phases</h1><p>Phase 1 switches on record reuse between offices; Phase 2 switches on mobile money; SIP runs once all three phases are live.</p></div></div>${card('', rolloutTable(ph, true))}`;
}, { roles: ['admin'] });

// ---------- services ----------
route(/^\/admin\/services$/, async () => {
  const [svcs, ags, types] = await Promise.all([api('/admin/services'), api('/admin/agencies'), api('/admin/record-types')]);
  const edit = async (s) => {
    const isNew = !s; s = s || { code: '', name: '', description: '', agency_id: ags[0].id, fee: 0, subject: 'person', sla_days: 14, output_name: '', output_validity_days: 365, origin: 'digitized', active: 1,
      form_schema: [{ name: 'example_field', label: 'Example field', type: 'text', required: true }], required_docs: [{ code: 'id', label: 'Applicant ZanID', record_type: 'national_id' }], referral_agencies: [] };
    const ok = await modalAction(isNew ? 'Digitize a service' : `Edit ${s.name}`, h`<div class="grid g2">
      <label class="f"><span>Code</span><input name="code" value="${s.code}" ${raw(isNew ? 'required' : 'disabled')} placeholder="E.G. MARKET_PERMIT"></label><label class="f"><span>Name</span><input name="name" value="${s.name}" required></label></div>
      <label class="f"><span>Description</span><textarea name="description">${s.description}</textarea></label>
      <div class="grid g2"><label class="f"><span>Responsible office</span><select name="agency_id">${ags.map((a) => h`<option value="${a.id}" ${a.id === s.agency_id ? raw('selected') : ''}>${a.name}</option>`)}</select></label>
      <label class="f"><span>Issued to</span><select name="subject"><option value="person">A person</option><option value="business" ${s.subject === 'business' ? raw('selected') : ''}>A registered business</option></select></label>
      <label class="f"><span>Fee (TZS)</span><input name="fee" type="number" min="0" value="${s.fee}"></label><label class="f"><span>Service standard (days)</span><input name="sla_days" type="number" min="1" value="${s.sla_days}"></label>
      <label class="f"><span>Output document name</span><input name="output_name" value="${s.output_name}"></label><label class="f"><span>Validity (days, blank = none)</span><input name="output_validity_days" type="number" value="${s.output_validity_days || ''}"></label>
      <label class="f"><span>Origin</span><select name="origin"><option value="digitized">Digitized (was manual)</option><option value="integrated" ${s.origin === 'integrated' ? raw('selected') : ''}>Integrated (was already online)</option></select></label>
      <label class="f"><span>Status</span><select name="active"><option value="1">Active</option><option value="0" ${!s.active ? raw('selected') : ''}>Inactive</option></select></label></div>
      <label class="f"><span>Standard referrals</span><div class="row">${ags.map((a) => h`<label class="row" style="gap:4px;font-weight:400"><input type="checkbox" name="ref_${a.code}" ${s.referral_agencies.includes(a.code) ? raw('checked') : ''}>${a.code}</label>`)}</div></label>
      <label class="f"><span>Form fields (JSON)</span><textarea name="form_schema" style="min-height:140px;font-family:monospace;font-size:12px">${JSON.stringify(s.form_schema, null, 2)}</textarea>
        <div class="hint">Each: {"name","label","type": text|number|date|select|textarea,"required",["options"],["prefill": "business.address" | "person.address"]}</div></label>
      <label class="f"><span>Required documents (JSON)</span><textarea name="required_docs" style="min-height:110px;font-family:monospace;font-size:12px">${JSON.stringify(s.required_docs, null, 2)}</textarea>
        <div class="hint">Each: {"code","label",["record_type"]}. With a record_type the document is satisfied automatically from verified records. Types: ${types.map((t) => t.code).join(', ')}</div></label>`,
    async (v) => {
      let form, docs;
      try { form = JSON.parse(v.form_schema); } catch { throw new Error('Form fields: invalid JSON'); }
      try { docs = JSON.parse(v.required_docs); } catch { throw new Error('Required documents: invalid JSON'); }
      const body = { ...v, agency_id: Number(v.agency_id), fee: Number(v.fee), sla_days: Number(v.sla_days), active: v.active === '1', form_schema: form, required_docs: docs,
        referral_agencies: ags.filter((a) => v['ref_' + a.code]).map((a) => a.code) };
      delete body.__fd;
      return isNew ? api('/admin/services', { body }) : api(`/admin/services/${s.id}`, { method: 'PUT', body });
    }, { submit: isNew ? 'Publish service' : 'Save', wide: true });
    if (ok) { toast('Saved'); refresh(); }
  };
  after(() => { document.getElementById('new').onclick = () => edit(null); document.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => edit(svcs.find((s) => s.id === Number(b.dataset.edit))); }); });
  return h`<div class="page-head"><div><h1>Services</h1><p>Digitizing a manual service means defining its online form, documents, routing, fee and service standard.</p></div><button class="btn primary" id="new">＋ Digitize a service</button></div>
    ${card('', h`<div class="table-wrap"><table class="t"><tr><th>Service</th><th>Office</th><th>Origin</th><th class="num">Fee</th><th class="num">Standard</th><th>Referrals</th><th>Status</th><th></th></tr>
    ${svcs.map((s) => h`<tr><td><b>${s.name}</b><br><small class="mono">${s.code}</small></td><td>${s.agency}</td><td>${s.origin === 'digitized' ? h`<span class="badge info">Digitized</span>` : h`<span class="badge">Integrated</span>`}</td>
      <td class="num">${money(s.fee)}</td><td class="num">${s.sla_days} d</td><td>${s.referral_agencies.join(', ') || '—'}</td><td>${s.active ? h`<span class="badge good">Active</span>` : h`<span class="badge">Inactive</span>`}</td><td><button class="btn small" data-edit="${s.id}">Edit</button></td></tr>`)}</table></div>`)}`;
}, { roles: ['admin'] });

// ---------- agencies ----------
route(/^\/admin\/agencies$/, async () => {
  const ags = await api('/admin/agencies');
  after(() => {
    document.getElementById('new').onclick = async () => {
      const ok = await modalAction('Add ministry, department or agency', h`<label class="f"><span>Code</span><input name="code" required placeholder="e.g. MOE"></label><label class="f"><span>Name</span><input name="name" required></label>
        <label class="f"><span>Type</span><select name="kind"><option value="ministry">Ministry</option><option value="department">Department</option><option value="agency">Agency</option><option value="local_government">Local government</option></select></label>`,
      (v) => api('/admin/agencies', { body: { code: v.code.toUpperCase(), name: v.name, kind: v.kind, integrated: true } }), { submit: 'Add' });
      if (ok) refresh();
    };
    document.querySelectorAll('[data-int]').forEach((b) => { b.onclick = async () => { await api(`/admin/agencies/${b.dataset.int}`, { method: 'PUT', body: { integrated: b.dataset.v === '1' } }); refresh(); }; });
  });
  return h`<div class="page-head"><div><h1>Ministries, departments and agencies</h1><p>Phase 1 participants. Integrated offices share verified records and exchange referrals.</p></div><button class="btn primary" id="new">＋ Add</button></div>
    ${card('', h`<table class="t"><tr><th>Code</th><th>Name</th><th>Type</th><th class="num">Services</th><th class="num">Staff</th><th>Integration</th></tr>
    ${ags.map((a) => h`<tr><td class="mono">${a.code}</td><td>${a.name}</td><td>${a.kind.replace('_', ' ')}</td><td class="num">${a.services}</td><td class="num">${a.staff}</td>
      <td>${a.integrated ? h`<span class="badge good">✓ Integrated</span>` : h`<span class="badge">Not yet</span>`} <button class="btn small link" data-int="${a.id}" data-v="${a.integrated ? 0 : 1}">${a.integrated ? 'Disconnect' : 'Connect'}</button></td></tr>`)}</table>`)}`;
}, { roles: ['admin'] });

// ---------- record sharing ----------
route(/^\/admin\/records$/, async () => {
  const [types, ags] = await Promise.all([api('/admin/record-types'), api('/admin/agencies')]);
  after(() => {
    document.querySelectorAll('input[data-rt]').forEach((cb) => {
      cb.onchange = async () => {
        const rt = cb.dataset.rt; const ids = [...document.querySelectorAll(`input[data-rt="${rt}"]:checked`)].map((x) => Number(x.dataset.ag));
        try { await api(`/admin/record-types/${rt}/grants`, { method: 'PUT', body: { agency_ids: ids } }); toast('Access updated'); } catch (e) { toast(e.message, true); }
      };
    });
    document.getElementById('new').onclick = async () => {
      const ok = await modalAction('New record type', h`<label class="f"><span>Code</span><input name="code" required placeholder="lower_snake_case"></label><label class="f"><span>Name</span><input name="name" required></label>
        <label class="f"><span>Owning (issuing) office</span><select name="owner_agency_id">${ags.map((a) => h`<option value="${a.id}">${a.name}</option>`)}</select></label>`,
      (v) => api('/admin/record-types', { body: { code: v.code, name: v.name, owner_agency_id: Number(v.owner_agency_id) } }), { submit: 'Create' });
      if (ok) refresh();
    };
  });
  return h`<div class="page-head"><div><h1>Record sharing</h1><p>Which offices may reuse which verified records. Owners always see their own records. Changes are audited.</p></div><button class="btn primary" id="new">＋ Record type</button></div>
    ${card('', h`<div class="table-wrap"><table class="t"><tr><th>Record</th><th>Owner</th>${ags.map((a) => h`<th title="${a.name}" style="text-align:center">${a.code}</th>`)}</tr>
    ${types.map((t) => h`<tr><td>${t.name}<br><small class="mono">${t.code}</small></td><td>${t.owner || '—'}</td>${ags.map((a) => h`<td style="text-align:center">${a.id === t.owner_agency_id ? h`<span class="badge good">owner</span>` : h`<input type="checkbox" data-rt="${t.code}" data-ag="${a.id}" ${t.granted_to.includes(a.id) ? raw('checked') : ''} aria-label="${a.code} may read ${t.name}">`}</td>`)}</tr>`)}</table></div>`)}`;
}, { roles: ['admin'] });

// ---------- users ----------
const ROLE_LABEL = { citizen: 'Applicant', front_office: 'Front office', back_office: 'Back office', finance: 'Finance', ministry_leader: 'Ministry leader', security: 'Security services', executive: 'Executive', admin: 'Administrator' };
route(/^\/admin\/users$/, async () => {
  const [users, ags] = await Promise.all([api('/admin/users'), api('/admin/agencies')]);
  after(() => {
    document.getElementById('new').onclick = async () => {
      const ok = await modalAction('Create staff account', h`<div class="grid g2"><label class="f"><span>Full name</span><input name="full_name" required></label><label class="f"><span>Username</span><input name="username" required></label>
        <label class="f"><span>Role</span><select name="role">${Object.entries(ROLE_LABEL).filter(([k]) => k !== 'citizen').map(([k, l]) => h`<option value="${k}">${l}</option>`)}</select></label>
        <label class="f"><span>Office</span><select name="agency_id"><option value="">— none —</option>${ags.map((a) => h`<option value="${a.id}">${a.name}</option>`)}</select></label>
        <label class="f"><span>Initial password</span><input name="password" type="text" required></label><label class="f"><span>Phone</span><input name="phone"></label></div>`,
      (v) => api('/admin/users', { body: { ...v, agency_id: v.agency_id ? Number(v.agency_id) : null, __fd: undefined } }), { submit: 'Create' });
      if (ok) { toast('Account created'); refresh(); }
    };
    document.querySelectorAll('[data-reset]').forEach((b) => { b.onclick = async () => {
      const ok = await modalAction('Reset password', h`<label class="f"><span>New password</span><input name="password" required></label>`, (v) => api(`/admin/users/${b.dataset.reset}`, { method: 'PUT', body: { password: v.password } }), { submit: 'Reset' });
      if (ok) toast('Password reset; user signed out everywhere'); }; });
    document.querySelectorAll('[data-active]').forEach((b) => { b.onclick = async () => { await api(`/admin/users/${b.dataset.active}`, { method: 'PUT', body: { active: b.dataset.v === '1' } }); refresh(); }; });
  });
  return h`<div class="page-head"><div><h1>Users</h1><p>Staff accounts are created here. Applicants register themselves with their ZanID.</p></div><button class="btn primary" id="new">＋ Staff account</button></div>
    ${card('', h`<div class="table-wrap"><table class="t"><tr><th>Name</th><th>Username</th><th>Role</th><th>Office</th><th>Status</th><th></th></tr>
    ${users.map((u) => h`<tr><td>${u.full_name}</td><td class="mono">${u.username}</td><td>${ROLE_LABEL[u.role]}</td><td>${u.agency || '—'}</td><td>${u.active ? h`<span class="badge good">Active</span>` : h`<span class="badge bad">Disabled</span>`}</td>
      <td class="row" style="flex-wrap:nowrap"><button class="btn small" data-reset="${u.id}">Reset password</button>${u.username !== S.me.username ? h`<button class="btn small" data-active="${u.id}" data-v="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button>` : ''}</td></tr>`)}</table></div>`)}`;
}, { roles: ['admin'] });

route(/^\/admin\/registry$/, async ({ query }) => {
  const people = await api('/admin/persons' + qs({ q: query.q }));
  after(() => {
    document.getElementById('sf').onsubmit = (e) => { e.preventDefault(); go('#/admin/registry' + qs({ q: new FormData(e.target).get('q') })); };
    document.getElementById('new').onclick = async () => {
      const ok = await modalAction('Add person to civil registry', h`<div class="grid g2"><label class="f"><span>ZanID</span><input name="zan_id" required></label><label class="f"><span>Full name</span><input name="full_name" required></label>
        <label class="f"><span>Date of birth</span><input name="dob" type="date" required></label><label class="f"><span>Sex</span><select name="sex"><option>F</option><option>M</option></select></label>
        <label class="f"><span>Mobile</span><input name="phone"></label><label class="f"><span>District</span><input name="district"></label></div><label class="f"><span>Address</span><input name="address"></label>`,
      (v) => api('/admin/persons', { body: { ...v, __fd: undefined } }), { submit: 'Add' });
      if (ok) refresh();
    };
  });
  return h`<div class="page-head"><div><h1>Civil registry</h1><p>Normally kept up to date by the civil registration agency’s system through the integration API (<span class="mono">POST /api/x/v1/persons</span>).</p></div>
    <div class="row"><form id="sf" class="row" style="flex-wrap:nowrap"><input name="q" value="${query.q || ''}" placeholder="Name or ZanID"><button class="btn">Search</button></form><button class="btn primary" id="new">＋ Person</button></div></div>
    ${card('', h`<div class="table-wrap"><table class="t"><tr><th>ZanID</th><th>Name</th><th>Date of birth</th><th>Phone</th><th>District</th></tr>${people.map((p) => h`<tr><td class="mono">${p.zan_id}</td><td>${p.full_name}</td><td>${p.dob}</td><td>${p.phone ? '+' + p.phone : '—'}</td><td>${p.district || '—'}</td></tr>`)}</table></div>`)}`;
}, { roles: ['admin'] });

// ---------- integration ----------
route(/^\/admin\/integration$/, async () => {
  const [keys, ags] = await Promise.all([api('/admin/api-keys'), api('/admin/agencies')]);
  after(() => {
    document.getElementById('new').onclick = async () => {
      const r = await modalAction('Issue API key', h`<label class="f"><span>Office</span><select name="agency_id">${ags.map((a) => h`<option value="${a.id}">${a.name}</option>`)}</select></label><label class="f"><span>Label</span><input name="label" placeholder="e.g. ZRB tax system"></label>`,
        (v) => api('/admin/api-keys', { body: { agency_id: Number(v.agency_id), label: v.label } }), { submit: 'Issue key' });
      if (r) { await modal('API key issued', h`<p>${r.note}</p><input readonly value="${r.key}" onclick="this.select()" class="mono">`, { submit: null }); refresh(); }
    };
    document.querySelectorAll('[data-revoke]').forEach((b) => { b.onclick = async () => { if (await confirmBox('Revoke key', 'Systems using this key will lose access immediately.', 'Revoke', true)) { await api(`/admin/api-keys/${b.dataset.revoke}`, { method: 'DELETE' }); refresh(); } }; });
  });
  const base = location.origin + '/api/x/v1';
  return h`<div class="page-head"><div><h1>Inter-agency integration API</h1><p>Each office’s own system connects with its key. Reads are limited to the record types the office is granted, and every call is audited.</p></div><button class="btn primary" id="new">＋ Issue key</button></div>
    <div class="split">${card('Keys', keys.length ? h`<table class="t"><tr><th>Office</th><th>Label</th><th>Key</th><th>Last used</th><th></th></tr>${keys.map((k) => h`<tr><td>${k.agency}</td><td>${k.label}</td><td class="mono">${k.key_prefix}…</td><td>${k.last_used_at ? ago(k.last_used_at) : 'never'}</td>
      <td>${k.active ? h`<button class="btn small danger" data-revoke="${k.id}">Revoke</button>` : h`<span class="badge">Revoked</span>`}</td></tr>`)}</table>` : empty('No keys issued'))}
    ${card('Endpoints', h`<p class="mono" style="word-break:break-all">${base}</p><ul style="padding-left:18px;margin:8px 0 0" class="mono">
      <li>GET /whoami</li><li>GET /persons/{zan_id}</li><li>GET /businesses/{brn}</li><li>POST /records</li><li>PATCH /records/{id}</li><li>POST /persons <small>(civil registry)</small></li>
      <li>POST /businesses <small>(business registry)</small></li><li>GET /referrals</li><li>POST /referrals/{id}/answer</li><li>GET /applications/{reference}</li></ul>
      <p class="hint" style="margin-top:8px">Header: <span class="mono">X-API-Key</span>. Optional <span class="mono">X-Purpose</span> is written to the audit log.</p>`)}</div>`;
}, { roles: ['admin'] });

route(/^\/admin\/providers$/, async () => {
  const [provs, cbs] = await Promise.all([api('/admin/providers'), api('/admin/callbacks')]);
  after(() => document.querySelectorAll('[data-prov]').forEach((b) => { b.onclick = async () => {
    const p = provs.find((x) => x.code === b.dataset.prov);
    const ok = await modalAction(`Configure ${p.name}`, h`<label class="f"><span>Mode</span><select name="mode"><option value="sandbox">Sandbox (built-in test network)</option><option value="live" ${p.mode === 'live' ? raw('selected') : ''}>Live</option></select></label>
      <label class="f"><span>Provider API base URL (live)</span><input name="api_base" value="${p.api_base || ''}" placeholder="https://api.provider.example/g2t"></label>
      <label class="f"><span>Callback signing secret</span><input name="callback_secret" placeholder="Leave blank to keep current (${p.secret_hint})"></label>
      <label class="f"><span>Enabled</span><select name="enabled"><option value="1">Yes</option><option value="0" ${!p.enabled ? raw('selected') : ''}>No</option></select></label>
      <p class="hint">Callback URL for the provider: <span class="mono">${location.origin}/api/payments/callback/${p.code}</span> – signed with HMAC-SHA256 in header X-Signature.</p>`,
    (v) => api(`/admin/providers/${p.code}`, { method: 'PUT', body: { mode: v.mode, api_base: v.api_base, callback_secret: v.callback_secret || undefined, enabled: v.enabled === '1' } }), { submit: 'Save' });
    if (ok) { S.providers = null; refresh(); } }; }));
  return h`<div class="page-head"><div><h1>Mobile money providers</h1><p>Government-to-telco (G2T) connections for Phase 2.</p></div></div>
    <div class="stack">${card('', h`<table class="t"><tr><th>Provider</th><th>Mode</th><th>API</th><th>Status</th><th></th></tr>${provs.map((p) => h`<tr><td><b>${p.name}</b><br><small class="mono">${p.code}</small></td><td>${p.mode === 'live' ? h`<span class="badge good">Live</span>` : h`<span class="badge warn">Sandbox</span>`}</td>
      <td class="mono">${p.api_base || '—'}</td><td>${p.enabled ? 'Enabled' : 'Disabled'}</td><td><button class="btn small" data-prov="${p.code}">Configure</button></td></tr>`)}</table>`)}
    ${card('Recent provider callbacks', cbs.length ? h`<div class="table-wrap"><table class="t"><tr><th>Received</th><th>Provider</th><th>Signature</th><th>Outcome</th><th>Body</th></tr>${cbs.map((c) => h`<tr><td>${fmtDateTime(c.received_at)}</td><td>${c.provider}</td><td>${c.signature_ok ? h`<span class="badge good">valid</span>` : h`<span class="badge bad">invalid</span>`}</td><td>${c.outcome}</td><td class="mono" style="font-size:11px;max-width:380px;word-break:break-all">${c.body}</td></tr>`)}</table></div>` : empty('No callbacks yet'))}</div>`;
}, { roles: ['admin'] });

route(/^\/admin\/audit$/, async ({ query }) => {
  const [rows, chain] = await Promise.all([api('/admin/audit' + qs({ action: query.action, user: query.user })), api('/admin/audit/verify')]);
  after(() => { document.getElementById('af').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); go('#/admin/audit' + qs({ action: f.get('action'), user: f.get('user') })); }; });
  return h`<div class="page-head"><div><h1>Audit log</h1><p>Every access and change, hash-chained so tampering is detectable.</p></div>
    <form id="af" class="row" style="flex-wrap:nowrap"><input name="action" value="${query.action || ''}" placeholder="Action (e.g. sip.)"><input name="user" value="${query.user || ''}" placeholder="User"><button class="btn">Filter</button></form></div>
    <div class="notice ${chain.ok ? 'good' : 'bad'}">${chain.ok ? `✓ Hash chain verified across ${chain.total} entries.` : `✕ Hash chain broken at entry #${chain.brokenAt}.`}</div>
    ${card('', h`<div class="table-wrap"><table class="t"><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Purpose</th><th>Detail</th></tr>
    ${rows.map((r) => h`<tr><td style="white-space:nowrap">${fmtDateTime(r.ts)}</td><td>${r.username}<br><small>${r.role}</small></td><td class="mono">${r.action}</td><td>${r.entity ? `${r.entity} ${r.entity_id || ''}` : '—'}</td><td>${r.purpose || ''}</td><td class="mono" style="font-size:11px;max-width:320px;word-break:break-all">${r.detail || ''}</td></tr>`)}</table></div>`)}`;
}, { roles: ['admin'] });

route(/^\/admin\/sms$/, async () => {
  const rows = await api('/admin/sms');
  return h`<div class="page-head"><div><h1>SMS outbox</h1><p>Messages queued for the SMS gateway (sandbox mode: delivered to this outbox).</p></div></div>
    ${card('', h`<div class="table-wrap"><table class="t"><tr><th>Time</th><th>To</th><th>Message</th><th>Status</th></tr>${rows.map((r) => h`<tr><td style="white-space:nowrap">${fmtDateTime(r.created_at)}</td><td class="mono">+${r.msisdn}</td><td>${r.message}</td><td>${r.status}</td></tr>`)}</table></div>`)}`;
}, { roles: ['admin'] });
