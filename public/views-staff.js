/* Front office, back office, finance */
'use strict';

async function staffHome() {
  const me = S.me;
  const [apps, refs] = await Promise.all([api('/applications'), api('/referrals')]);
  const open = apps.filter((a) => ['submitted', 'awaiting_applicant', 'in_review', 'awaiting_payment', 'approved'].includes(a.status));
  const mine = open.filter((a) => a.assigned_to === me.id);
  const todo = me.role === 'front_office' ? open.filter((a) => a.status === 'submitted') : open.filter((a) => ['in_review', 'approved'].includes(a.status));
  const late = open.filter((a) => a.age_days > a.sla_days);
  return h`<div class="page-head"><div><h1>${me.agency_name}</h1><p>${me.role_label} · ${me.full_name}</p></div>
    <div class="row">${me.role === 'front_office' ? h`<a class="btn primary" href="#/desk">＋ Assisted application</a>` : ''}<a class="btn" href="#/queue">Open queue</a></div></div>
    <div class="grid g4" style="margin-bottom:16px">${statTile(me.role === 'front_office' ? 'New submissions to check' : 'Cases to review or issue', todo.length)}
      ${statTile('Assigned to me', mine.length)}${statTile('Incoming referrals', refs.length, 'from other offices')}${statTile('Past service standard', late.length, late.length ? 'needs attention' : 'all within standard')}</div>
    <div class="split">${card(me.role === 'front_office' ? 'Waiting for front office check' : 'Ready for decision', appsTable(todo.slice(0, 10)), h`<a href="#/queue">All cases</a>`)}
      ${card('Incoming referrals', refs.length ? h`<ul class="doclist">${refs.slice(0, 8).map((r) => h`<li><div style="flex:1"><a href="#/app/${r.application_id}" class="mono">${r.reference}</a><br><small>${r.from_agency} · ${r.service} · ${r.age_days} d</small></div></li>`)}</ul>` : empty('No open referrals'), h`<a href="#/referrals">All</a>`)}</div>`;
}

const QUEUE_TABS = [
  ['open', 'All open', 'submitted,awaiting_applicant,in_review,awaiting_payment,approved'], ['submitted', 'New', 'submitted'], ['awaiting_applicant', 'Waiting on applicant', 'awaiting_applicant'],
  ['in_review', 'In review', 'in_review'], ['payment', 'Awaiting payment', 'awaiting_payment'], ['approved', 'Ready to issue', 'approved'], ['closed', 'Closed', 'issued,rejected,withdrawn'],
];
route(/^\/queue$/, async ({ query }) => {
  const tab = QUEUE_TABS.find((t) => t[0] === query.tab) || QUEUE_TABS[0];
  const apps = await api('/applications' + qs({ status: tab[2], q: query.q, mine: query.mine }));
  after(() => { document.getElementById('qf').onsubmit = (e) => { e.preventDefault(); go('#/queue' + qs({ tab: tab[0], q: new FormData(e.target).get('q'), mine: query.mine })); }; });
  return h`<div class="page-head"><div><h1>Case queue</h1><p>${S.me.agency_name}</p></div>
    <form id="qf" class="row" style="flex-wrap:nowrap"><input name="q" value="${query.q || ''}" placeholder="Reference, name, ZanID, business"><button class="btn">Search</button></form></div>
    <div class="tabs">${QUEUE_TABS.map((t) => h`<a href="#/queue${qs({ tab: t[0], mine: query.mine })}" class="${t === tab ? 'active' : ''}">${t[1]}</a>`)}
      <span class="spacer"></span><a href="#/queue${qs({ tab: tab[0], mine: query.mine ? '' : '1' })}" class="${query.mine ? 'active' : ''}">Assigned to me</a></div>
    ${card('', appsTable(apps))}`;
}, { roles: ['front_office', 'back_office', 'ministry_leader'] });

route(/^\/referrals$/, async ({ query }) => {
  const st = query.status || 'open';
  const refs = await api('/referrals' + qs({ status: st }));
  return h`<div class="page-head"><div><h1>Incoming referrals</h1><p>Cases other offices have referred to ${S.me.agency_name}. Your answer goes straight back to them.</p></div></div>
    <div class="tabs"><a href="#/referrals" class="${st === 'open' ? 'active' : ''}">Open</a><a href="#/referrals?status=answered" class="${st === 'answered' ? 'active' : ''}">Answered</a></div>
    ${card('', refs.length ? h`<div class="table-wrap"><table class="t"><tr><th>Case</th><th>From</th><th>Question</th><th>Applicant</th><th>Age</th><th>Outcome</th></tr>
      ${refs.map((r) => h`<tr class="click" data-href="#/app/${r.application_id}"><td><a class="mono" href="#/app/${r.application_id}">${r.reference}</a><br><small>${r.service}</small></td><td>${r.from_agency}</td><td>${r.question}</td><td>${r.applicant}</td>
        <td><span class="${r.status === 'open' && r.age_days > 3 ? 'badge bad' : ''}">${r.age_days} d</span></td><td>${r.status === 'open' ? h`<span class="badge warn">Awaiting you</span>` : r.outcome === 'cleared' ? h`<span class="badge good">Cleared</span>` : h`<span class="badge bad">Objection</span>`}</td></tr>`)}</table></div>` : empty('Nothing here'))}`;
}, { roles: ['front_office', 'back_office', 'ministry_leader'] });

// Assisted application at a government service desk
route(/^\/desk$/, async ({ query }) => {
  let person = null; let body = '';
  if (query.zan) {
    try { person = await api('/persons/lookup' + qs({ zan_id: query.zan })); } catch (e) { body = h`<div class="notice bad">${e.message}</div>`; }
  }
  if (person && query.service) {
    body = await applicationForm({ serviceId: query.service, person, businessId: query.business, desk: true });
  } else if (person) {
    const svcs = (await api('/services')).filter((s) => s.agency_id === S.me.agency_id);
    body = h`<div class="split">${card('Choose the service', svcs.length ? h`<ul class="doclist">${svcs.map((s) => h`<li><div style="flex:1"><b>${s.name}</b><br><small>${s.fee ? money(s.fee) : 'Free'} · ${s.sla_days} days</small></div><a class="btn small primary" href="#/desk?zan=${person.zan_id}&service=${s.id}">Start</a></li>`)}</ul>` : empty('Your agency has no services'))}
      ${card('Applicant (civil registry)', h`${dl([['Name', person.full_name], ['ZanID', person.zan_id], ['Date of birth', fmtDate(person.dob)], ['Phone', person.phone], ['Address', person.address]])}
        <h3 style="margin:12px 0 4px">Businesses</h3>${person.businesses.length ? h`<ul class="doclist">${person.businesses.map((b) => h`<li>${b.name}<small>BRN ${b.brn}</small></li>`)}</ul>` : h`<p class="muted">None</p>`}`)}</div>`;
  }
  after(() => { const f = document.getElementById('lookup'); f.onsubmit = (e) => { e.preventDefault(); go('#/desk?zan=' + encodeURIComponent(new FormData(f).get('zan').trim())); }; });
  return h`<div class="page-head"><div><h1>Assisted application</h1><p>Submit a paper application online on the applicant’s behalf. The applicant receives the tracking reference by SMS.</p></div>
    <form id="lookup" class="row" style="flex-wrap:nowrap"><input name="zan" value="${query.zan || ''}" placeholder="Applicant ZanID" required><button class="btn primary">Look up</button></form></div>${body}`;
}, { roles: ['front_office'] });

// ================= finance =================
async function financeHome() {
  const s = await api('/finance/summary');
  const maxA = Math.max(1, ...s.by_agency.map((x) => x.amount));
  return h`<div class="page-head"><div><h1>Revenue and reconciliation</h1><p>Mobile money and counter collections across all integrated offices.</p></div><a class="btn primary" href="#/finance/reconcile">Reconcile statements</a></div>
    <div class="grid g4" style="margin-bottom:16px">${statTile('Collected today', money(s.today.amount), `${s.today.n} payments`)}${statTile('This month', money(s.month.amount), `${s.month.n} payments`)}
      ${statTile('Paid, not reconciled', money(s.unreconciled.amount), `${s.unreconciled.n} payments`)}${statTile('Outstanding bills', money(s.outstanding.amount), `${s.outstanding.n} bills`)}</div>
    <div class="split"><div class="stack">${card('Collections by office', h`<table class="t"><tr><th>Office</th><th class="num">Payments</th><th class="num">Amount</th><th></th></tr>
      ${s.by_agency.map((x) => h`<tr><td>${x.agency}</td><td class="num">${x.n}</td><td class="num">${money(x.amount)}</td><td style="width:30%"><div class="bar-inline"><div style="width:${Math.round(x.amount / maxA * 100)}%"></div></div></td></tr>`)}</table>`)}
      ${card('By channel', h`<table class="t"><tr><th>Channel</th><th class="num">Payments</th><th class="num">Amount</th></tr>${s.by_provider.map((x) => h`<tr><td>${x.provider}</td><td class="num">${x.n}</td><td class="num">${money(x.amount)}</td></tr>`)}</table>`)}</div>
    ${card('Payment exceptions', s.alerts.length ? h`<ul class="doclist">${s.alerts.map((a) => h`<li><div style="flex:1">${sevBadge(a.severity)} <b>${a.title}</b><br><small>${a.detail}</small>${a.entity === 'application' && a.entity_id ? h`<br><a href="#/app/${a.entity_id}">Open case</a>` : ''}</div></li>`)}</ul>` : empty('No exceptions'))}</div>`;
}

route(/^\/finance\/payments$/, async ({ query }) => {
  const rows = await api('/finance/payments' + qs({ status: query.status, reconciled: query.reconciled, q: query.q }));
  const tabs = [['', '', 'All'], ['paid', '', 'Paid'], ['paid', '0', 'Paid – unreconciled'], ['pending', '', 'Pending'], ['unpaid', '', 'Unpaid'], ['failed', '', 'Failed']];
  after(() => {
    document.getElementById('pf').onsubmit = (e) => { e.preventDefault(); go('#/finance/payments' + qs({ ...query, q: new FormData(e.target).get('q') })); };
    document.querySelectorAll('[data-counter]').forEach((b) => { b.onclick = async () => {
      const ok = await modalAction('Record counter payment', h`<p>Use when the applicant paid at a government cashier or bank.</p><label class="f"><span>Cashier receipt / bank slip reference</span><input name="reference" required></label>`,
        (v) => api(`/finance/payments/${b.dataset.counter}/counter`, { body: { reference: v.reference } }), { submit: 'Record payment' });
      if (ok) { toast('Payment recorded'); refresh(); } }; });
    document.querySelectorAll('[data-recon]').forEach((b) => { b.onclick = async () => {
      const ok = await modalAction('Reconcile manually', h`<label class="f"><span>Evidence used (statement reference, bank confirmation…)</span><input name="note" required></label>`,
        (v) => api(`/finance/payments/${b.dataset.recon}/reconcile`, { body: { note: v.note } }), { submit: 'Mark reconciled' });
      if (ok) { toast('Reconciled'); refresh(); } }; });
  });
  return h`<div class="page-head"><div><h1>Payments</h1><p>Every bill is matched to its application by control number.</p></div>
    <form id="pf" class="row" style="flex-wrap:nowrap"><input name="q" value="${query.q || ''}" placeholder="Control no., reference, provider ref"><button class="btn">Search</button></form></div>
    <div class="tabs">${tabs.map(([st, rc, l]) => h`<a href="#/finance/payments${qs({ status: st, reconciled: rc })}" class="${(query.status || '') === st && (query.reconciled || '') === rc ? 'active' : ''}">${l}</a>`)}</div>
    ${card('', rows.length ? h`<div class="table-wrap"><table class="t"><tr><th>Control no.</th><th>Application</th><th>Office</th><th class="num">Amount</th><th>Status</th><th>Channel</th><th>Paid</th><th></th></tr>
      ${rows.map((p) => h`<tr><td class="mono">${p.control_number}</td><td><a href="#/app/${p.application_id}" class="mono">${p.reference}</a><br><small>${p.payer}</small></td><td>${p.agency}<br><small>${p.service}</small></td>
        <td class="num">${money(p.amount)}</td><td>${payBadge(p.status)}${p.status === 'paid' ? h`<br>${p.reconciled ? h`<small>✓ reconciled</small>` : h`<small>not reconciled</small>`}` : ''}</td>
        <td>${p.provider_name || (p.provider_ref && p.provider_ref.startsWith('COUNTER') ? 'Counter' : '—')}${p.msisdn ? h`<br><small>+${p.msisdn}</small>` : ''}</td><td>${p.paid_at ? fmtDateTime(p.paid_at) : '—'}${p.receipt_no ? h`<br><a href="/api/payments/${p.id}/receipt" target="_blank"><small>${p.receipt_no}</small></a>` : ''}</td>
        <td>${p.status !== 'paid' ? h`<button class="btn small" data-counter="${p.id}">Record counter payment</button>` : !p.reconciled ? h`<button class="btn small" data-recon="${p.id}">Reconcile</button>` : ''}</td></tr>`)}</table></div>` : empty('No payments'))}`;
}, { roles: ['finance', 'admin'] });

route(/^\/finance\/reconcile$/, async () => {
  const [provs, lines] = await Promise.all([api('/payments/providers'), api('/finance/statement-lines')]);
  after(() => {
    const f = document.getElementById('imp');
    document.getElementById('fetch').onclick = async () => {
      const fd = new FormData(f);
      try { const r = await api('/finance/statement' + qs({ provider: fd.get('provider'), day: fd.get('day') })); f.querySelector('textarea').value = r.csv; toast('Statement loaded from sandbox provider'); } catch (e) { toast(e.message, true); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault(); const fd = new FormData(f);
      try { const r = await api('/finance/statement', { body: { provider: fd.get('provider'), csv: fd.get('csv') } }); toast(`Matched ${r.matched}, mismatched ${r.mismatch}, unmatched ${r.unmatched}, already reconciled ${r.already}`); refresh(); } catch (ex) { toast(ex.message, true); }
    };
    const file = document.getElementById('csvfile');
    file.onchange = async () => { if (file.files[0]) f.querySelector('textarea').value = await file.files[0].text(); };
  });
  const cls = { matched: 'good', mismatch: 'bad', unmatched: 'bad', already: '' };
  return h`<div class="page-head"><div><h1>Reconciliation</h1><p>Import each provider’s settlement statement. Lines are matched to bills by control number and transaction reference; differences raise exceptions.</p></div></div>
    <div class="split">${card('Import provider statement', h`<form id="imp"><div class="grid g2"><label class="f"><span>Provider</span><select name="provider">${provs.map((p) => h`<option value="${p.code}">${p.name}</option>`)}</select></label>
      <label class="f"><span>Statement date</span><input type="date" name="day" value="${new Date().toISOString().slice(0, 10)}"></label></div>
      <label class="f"><span>Statement (CSV: provider_ref, control_number, amount, txn_date)</span><textarea name="csv" style="min-height:160px;font-family:monospace;font-size:12px" required></textarea></label>
      <div class="row"><input type="file" id="csvfile" accept=".csv,text/csv" style="max-width:260px"><button type="button" class="btn" id="fetch">Fetch from sandbox provider</button><div class="spacer"></div><button class="btn primary">Import and match</button></div></form>`)}
    ${card('How matching works', h`<ul style="margin:0;padding-left:18px"><li><b>Matched</b> – bill paid with the same amount; marked reconciled.</li><li><b>Mismatch</b> – amount or status differs; raised as an exception.</li><li><b>Unmatched</b> – no bill with that control number; raised as an exception.</li></ul>`)}</div>
    <div style="margin-top:16px">${card('Recent statement lines', lines.length ? h`<div class="table-wrap"><table class="t"><tr><th>Imported</th><th>Provider</th><th>Provider ref</th><th>Control no.</th><th class="num">Amount</th><th>Result</th></tr>
      ${lines.map((l) => h`<tr><td>${fmtDateTime(l.imported_at)}<br><small>${l.imported_by_name}</small></td><td>${l.provider}</td><td class="mono">${l.provider_ref}</td><td class="mono">${l.control_number}</td><td class="num">${money(l.amount)}</td><td><span class="badge ${cls[l.match_status]}">${l.match_status}</span></td></tr>`)}</table></div>` : empty('No statements imported yet'))}</div>`;
}, { roles: ['finance', 'admin'] });
