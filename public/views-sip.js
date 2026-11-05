/* Sovereign Intelligence Platform: ministry, security and executive views */
'use strict';

const RULES = {
  sla_breach: 'Past service standard', sla_critical: 'Far past service standard', referral_overdue: 'Referral overdue', escalated: 'Escalated case',
  document_reuse: 'Same document, different applicants', shared_phone: 'Phone shared by several identities', third_party_payment: 'Paid from another person’s number',
  high_volume: 'Unusual application volume', amount_mismatch: 'Payment amount mismatch', unmatched_callback: 'Unmatched payment',
};

function alertList(alerts, { ack = true } = {}) {
  if (!alerts.length) return empty('No open alerts');
  return h`<ul class="doclist">${alerts.map((a) => h`<li><div style="flex:1;min-width:200px">${sevBadge(a.severity)} <b>${a.title}</b><br><small>${RULES[a.rule] || a.rule}${a.agency ? ' · ' + a.agency : ''} · ${ago(a.created_at)}</small>${a.detail ? h`<br><small class="t2">${a.detail}</small>` : ''}</div>
    ${a.entity === 'application' && a.entity_id ? h`<a class="btn small" href="#/app/${a.entity_id}">Open case</a>` : ''}${ack && a.status === 'open' ? h`<button class="btn small" data-ack="${a.id}">Acknowledge</button>` : ''}</li>`)}</ul>`;
}
function wireAcks() {
  document.querySelectorAll('[data-ack]').forEach((b) => { b.onclick = async () => { try { await api(`/sip/alerts/${b.dataset.ack}/ack`, { body: {} }); toast('Acknowledged'); refresh(); } catch (e) { toast(e.message, true); } }; });
  const rf = document.getElementById('sip-refresh'); if (rf) rf.onclick = async () => { await api('/sip/refresh', { body: {} }); toast('Refreshed'); refresh(); };
}
const dayLabel = (r) => new Date(r.day + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function kpis(m) {
  return h`<div class="grid g4" style="margin-bottom:16px">${statTile('Open cases', m.open, `${m.new_24h} new in last 24 h`)}${statTile('Past service standard', m.breaches, m.open ? `${Math.round(m.breaches / m.open * 100)}% of open cases` : '')}
    ${statTile('Issued in 30 days', m.issued_30d, m.on_time_rate != null ? `${m.on_time_rate}% within standard` : '')}${statTile('Average time to issue', m.avg_days != null ? `${m.avg_days} d` : '—', `${money(m.collected_30d)} collected in 30 days`)}</div>`;
}
function serviceTable(rows) {
  return h`<div class="table-wrap"><table class="t"><tr><th>Service</th><th class="num">Total</th><th class="num">Open</th><th class="num">Past standard</th><th class="num">Avg days</th><th class="num">Standard</th></tr>
    ${rows.map((s) => h`<tr><td>${s.name}</td><td class="num">${s.total}</td><td class="num">${s.open}</td><td class="num">${s.breaches ? h`<span class="badge bad">${s.breaches}</span>` : 0}</td><td class="num">${s.avg_days ?? '—'}</td><td class="num">${s.sla_days}</td></tr>`)}</table></div>`;
}
function queueTable(q, withAgency) {
  if (!q.length) return empty('Nothing requires action');
  return h`<div class="table-wrap"><table class="t"><tr><th>Case</th>${withAgency ? h`<th>Office</th>` : ''}<th>Status</th><th class="num">Age</th></tr>
    ${q.map((a) => h`<tr class="click" data-href="#/app/${a.id}"><td><a class="mono" href="#/app/${a.id}">${a.reference}</a>${a.escalated ? h` <span class="badge bad">Escalated</span>` : ''}<br><small>${a.service} · ${a.applicant}</small></td>${withAgency ? h`<td>${a.agency}</td>` : ''}<td>${statusBadge(a.status)}</td>
      <td class="num"><span class="${a.age_days > a.sla_days ? 'badge bad' : 'badge warn'}">${a.age_days} / ${a.sla_days} d</span></td></tr>`)}</table></div>`;
}

route(/^\/sip$/, async () => {
  const o = await api('/sip/overview');
  after(wireAcks);
  const head = (title, sub) => h`<div class="page-head"><div><span class="badge info">SIP · Sovereign Intelligence Platform</span><h1 style="margin-top:6px">${title}</h1><p>${sub}</p></div>
    <button class="btn" id="sip-refresh">↻ Refresh</button></div>`;
  const chart = (m) => card('Applications received and issued – last 14 days', barChart(m.daily, [{ key: 'received', name: 'Received', color: '--series-1' }, { key: 'issued', name: 'Issued', color: '--series-2' }], { label: dayLabel }));

  if (o.scope === 'ministry') {
    return h`${head(o.agency, 'Your ministry’s performance, service delays and cases requiring action. Access is logged.')}${kpis(o.metrics)}
      <div class="split"><div class="stack">${chart(o.metrics)}${card('Cases requiring action', queueTable(o.queue, false))}${card('By service', serviceTable(o.metrics.by_service))}</div>
      <div class="stack">${card('Alerts', alertList(o.alerts))}${card('Referral backlog', h`<div class="stat" style="padding:0"><div class="value">${o.metrics.open_referrals}</div><div class="sub">referrals from other offices awaiting your answer</div></div><a href="#/referrals">View referrals</a>`)}</div></div>`;
  }
  if (o.scope === 'security') {
    return h`${head('Security intelligence', 'Risk alerts, patterns and links between records from integrated data. Every search requires a stated purpose and is logged.')}
      <div class="grid g4" style="margin-bottom:16px">${o.by_rule.slice(0, 4).map((r) => statTile(RULES[r.rule] || r.rule, r.n, 'open alerts'))}</div>
      <div class="split">${card('Risk alerts', alertList(o.alerts))}${card('Investigate', h`<p>Search a ZanID, BRN, TIN, phone number or name to see linked identities, businesses, applications, payments and shared documents.</p><a class="btn primary" href="#/sip/links">Open link analysis</a>`)}</div>`;
  }
  const maxOpen = Math.max(1, ...o.ministries.map((x) => x.open));
  return h`${head('Executive dashboard', `One view of government service delivery. Updated continuously; daily snapshot ${o.snapshot ? 'taken ' + fmtDateTime(o.snapshot.created_at) : 'pending'}.`)}${kpis(o.metrics)}
    <div class="split"><div class="stack">${chart(o.metrics)}
      ${card('Ministry performance', h`<div class="table-wrap"><table class="t"><tr><th>Ministry / agency</th><th class="num">Open</th><th></th><th class="num">Past standard</th><th class="num">Avg days</th><th class="num">Referrals waiting</th><th class="num">Alerts</th></tr>
        ${o.ministries.map((m) => h`<tr class="click" data-href="#/sip/ministry/${m.id}"><td><a href="#/sip/ministry/${m.id}">${m.name}</a></td><td class="num">${m.open}</td><td style="width:90px"><div class="bar-inline"><div style="width:${Math.round(m.open / maxOpen * 100)}%"></div></div></td>
          <td class="num">${m.breaches ? h`<span class="badge bad">${m.breaches}</span>` : 0}</td><td class="num">${m.avg_days ?? '—'}</td><td class="num">${m.open_referrals}</td><td class="num">${m.open_alerts}</td></tr>`)}</table></div>`)}
      ${card('Matters requiring executive attention', queueTable(o.queue.slice(0, 12), true))}</div>
    <div class="stack">${card('Priority alerts', alertList(o.alerts.slice(0, 15)))}
      ${card('Security summary', h`<p><b>${o.security_summary.open || 0}</b> open security alerts, <b>${o.security_summary.high || 0}</b> critical. Details are restricted to authorized security services.</p>`)}</div></div>`;
}, { roles: ['ministry_leader', 'security', 'executive', 'admin'] });

route(/^\/sip\/ministry\/(\d+)$/, async ({ params }) => {
  const o = await api('/sip/ministry/' + params[0]);
  after(wireAcks);
  return h`<div class="page-head"><div><a href="#/sip">← Executive dashboard</a><h1 style="margin-top:6px">${o.agency}</h1></div></div>${kpis(o.metrics)}
    <div class="split"><div class="stack">${card('Applications – last 14 days', barChart(o.metrics.daily, [{ key: 'received', name: 'Received', color: '--series-1' }, { key: 'issued', name: 'Issued', color: '--series-2' }], { label: dayLabel }))}
      ${card('By service', serviceTable(o.metrics.by_service))}${card('Cases requiring action', queueTable(o.queue, false))}</div>${card('Open alerts', alertList(o.alerts, { ack: false }))}</div>`;
}, { roles: ['executive', 'admin'] });

route(/^\/sip\/history$/, async () => {
  const rows = await api('/sip/snapshots');
  return h`<div class="page-head"><div><h1>Daily snapshots</h1><p>Recorded once a day for the executive record.</p></div></div>
    ${card('', rows.length ? h`<table class="t"><tr><th>Day</th><th class="num">Open cases</th><th class="num">Past standard</th><th class="num">Issued (30 d)</th><th class="num">Critical alerts</th></tr>
      ${rows.map((r) => h`<tr><td>${fmtDate(r.day)}</td><td class="num">${r.open}</td><td class="num">${r.breaches}</td><td class="num">${r.issued_30d}</td><td class="num">${r.high_alerts}</td></tr>`)}</table>` : empty('No snapshots yet'))}`;
}, { roles: ['executive', 'admin'] });

route(/^\/sip\/links$/, async ({ query }) => {
  let result = '';
  if (query.q) {
    try {
      const r = await api('/sip/links' + qs({ q: query.q, purpose: query.purpose }));
      result = h`<div class="split" style="margin-top:16px">${card(`Link graph – ${r.nodes.length} entities`, r.nodes.length ? graph(r) : empty('No matches'))}
        <div class="stack">${card('Entities', h`<ul class="doclist">${r.nodes.map((n) => h`<li><span class="badge">${n.type}</span><div style="flex:1">${n.type === 'application' ? h`<a href="#/app/${n.id.slice(1)}">${n.label}</a>` : n.label}
          ${n.zan_id ? h`<br><small>ZanID ${n.zan_id}${n.phone ? ' · +' + n.phone : ''}</small>` : ''}${n.brn ? h`<br><small>BRN ${n.brn} · TIN ${n.tin}</small>` : ''}${n.service ? h`<br><small>${n.service} · ${n.status}</small>` : ''}</div></li>`)}</ul>`)}
        ${card('Related alerts', alertList(r.alerts))}</div></div>`;
    } catch (e) { result = h`<div class="notice bad" style="margin-top:16px">${e.message}</div>`; }
  }
  after(() => { wireAcks(); document.getElementById('lk').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); go('#/sip/links' + qs({ q: f.get('q'), purpose: f.get('purpose') })); }; });
  return h`<div class="page-head"><div><span class="badge info">SIP · Security services</span><h1 style="margin-top:6px">Link analysis</h1><p>Authorized use only. The search and its purpose are written to the audit log.</p></div></div>
    ${card('', h`<form id="lk" class="grid g3" style="align-items:end"><label class="f" style="margin:0"><span>ZanID, BRN, TIN, phone or name</span><input name="q" value="${query.q || ''}" required></label>
      <label class="f" style="margin:0"><span>Purpose (case / file number)</span><input name="purpose" value="${query.purpose || ''}" required minlength="5"></label><button class="btn primary">Search</button></form>`)}${result}`;
}, { roles: ['security'] });

// simple radial layout graph
function graph({ nodes, edges }) {
  const W = 640, H = 420, cx = W / 2, cy = H / 2;
  const color = { person: 'var(--series-1)', business: 'var(--series-2)', application: 'var(--muted)', phone: 'var(--warn)' };
  const pos = {}; const centers = nodes.filter((n) => n.type === 'person');
  centers.forEach((n, i) => { const a = (i / Math.max(1, centers.length)) * Math.PI * 2; const r = centers.length > 1 ? 110 : 0; pos[n.id] = [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; });
  const rest = nodes.filter((n) => !pos[n.id]);
  rest.forEach((n, i) => { const a = (i / Math.max(1, rest.length)) * Math.PI * 2 + 0.3; const r = 175 + (i % 2) * 20; pos[n.id] = [cx + Math.cos(a) * r * 1.3, cy + Math.sin(a) * r * 0.95]; });
  const clamp = ([x, y]) => [Math.max(60, Math.min(W - 60, x)), Math.max(20, Math.min(H - 20, y))];
  for (const k in pos) pos[k] = clamp(pos[k]);
  let s = '';
  for (const e of edges) { const a = pos[e.from], b = pos[e.to]; if (!a || !b) continue; s += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" ${e.label === 'same document file' || e.label === 'paid for' ? 'stroke-dasharray="5 4" style="stroke:var(--bad)"' : ''}><title>${esc(e.label)}</title></line>`; }
  for (const n of nodes) { const [x, y] = pos[n.id]; s += `<g><circle cx="${x}" cy="${y}" r="${n.type === 'person' ? 11 : 8}" fill="${color[n.type]}" stroke="var(--surface)" stroke-width="2"><title>${esc(n.type)}: ${esc(n.label)}</title></circle><text x="${x}" y="${y + 22}" text-anchor="middle">${esc(n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label)}</text></g>`; }
  return h`<div class="legend" style="margin-bottom:8px"><span><i style="background:var(--series-1)"></i>Person</span><span><i style="background:var(--series-2)"></i>Business</span><span><i style="background:var(--muted)"></i>Application</span><span><i style="background:var(--warn)"></i>Phone</span><span style="color:var(--bad)">- - - risk link</span></div>
    <svg class="graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="Link graph">${raw(s)}</svg>`;
}
