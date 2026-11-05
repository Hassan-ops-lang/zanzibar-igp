'use strict';
/*
 * Sovereign Intelligence Platform (SIP): metrics, rule-based alerts, link analysis and daily snapshots,
 * computed from the integrated IGP data. All reads through the API are audit-logged by the routes.
 */
const { one, all, run, getSetting } = require('../db');
const { OPEN_STATUSES } = require('./workflow');

const IN_OPEN = `(${OPEN_STATUSES.map((s) => `'${s}'`).join(',')})`;

function sipEnabled() {
  const p = getSetting('phases', {});
  return ['phase1', 'phase2', 'phase3'].every((k) => p[k] && p[k].live);
}

function upsertAlert(a) {
  run(`INSERT OR IGNORE INTO alerts(rule, severity, agency_id, entity, entity_id, fingerprint, title, detail, audience)
       VALUES(?,?,?,?,?,?,?,?,?)`, a.rule, a.severity, a.agency_id || null, a.entity || null, a.entity_id || null,
  a.fingerprint, a.title, a.detail || null, a.audience || 'ministry');
}

function runRules() {
  // 1. Service-level breaches (ministry)
  for (const r of all(`SELECT ap.id, ap.reference, s.name, s.agency_id, s.sla_days,
      CAST(julianday('now') - julianday(ap.created_at) AS INTEGER) AS age
      FROM applications ap JOIN services s ON s.id = ap.service_id
      WHERE ap.status IN ${IN_OPEN} AND julianday('now') - julianday(ap.created_at) > s.sla_days`)) {
    upsertAlert({ rule: 'sla_breach', severity: r.age > r.sla_days * 2 ? 'high' : 'medium', agency_id: r.agency_id,
      entity: 'application', entity_id: r.id, fingerprint: `sla:${r.id}`,
      title: `${r.reference} past service standard`, detail: `${r.name}: open ${r.age} days (standard ${r.sla_days})` });
    if (r.age > r.sla_days * 2) {
      upsertAlert({ rule: 'sla_critical', severity: 'high', agency_id: r.agency_id, entity: 'application', entity_id: r.id,
        fingerprint: `slax:${r.id}`, audience: 'executive', title: `${r.reference} more than twice past standard`,
        detail: `${r.name}: open ${r.age} days (standard ${r.sla_days})` });
    }
  }
  // 2. Overdue referrals (> 3 days)
  for (const r of all(`SELECT rf.id, rf.application_id, rf.to_agency_id, ap.reference, a.name AS agency,
      CAST(julianday('now') - julianday(rf.created_at) AS INTEGER) AS age
      FROM referrals rf JOIN applications ap ON ap.id = rf.application_id JOIN agencies a ON a.id = rf.to_agency_id
      WHERE rf.status = 'open' AND julianday('now') - julianday(rf.created_at) > 3`)) {
    upsertAlert({ rule: 'referral_overdue', severity: 'medium', agency_id: r.to_agency_id, entity: 'application', entity_id: r.application_id,
      fingerprint: `ref:${r.id}`, title: `Referral on ${r.reference} unanswered`, detail: `${r.agency} has not responded for ${r.age} days` });
  }
  // 3. Escalated cases (executive)
  for (const r of all(`SELECT ap.id, ap.reference, s.agency_id, s.name FROM applications ap JOIN services s ON s.id = ap.service_id
      WHERE ap.escalated = 1 AND ap.status IN ${IN_OPEN}`)) {
    upsertAlert({ rule: 'escalated', severity: 'high', agency_id: r.agency_id, entity: 'application', entity_id: r.id,
      fingerprint: `esc:${r.id}`, audience: 'executive', title: `${r.reference} escalated for executive attention`, detail: r.name });
  }
  // 4. Same document file submitted by different applicants (security)
  for (const r of all(`SELECT d.sha256, COUNT(DISTINCT ap.person_id) AS people, GROUP_CONCAT(DISTINCT ap.reference) AS refs
      FROM documents d JOIN applications ap ON ap.id = d.application_id GROUP BY d.sha256 HAVING people > 1`)) {
    upsertAlert({ rule: 'document_reuse', severity: 'high', audience: 'security', entity: 'document', fingerprint: `doc:${r.sha256}`,
      title: `Identical document submitted by ${r.people} different applicants`, detail: `Applications: ${r.refs}. File hash ${r.sha256.slice(0, 16)}…` });
  }
  // 5. One phone number linked to several identities (security)
  for (const r of all(`SELECT phone, COUNT(*) AS n, GROUP_CONCAT(full_name, '; ') AS names FROM persons
      WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING n >= 2`)) {
    upsertAlert({ rule: 'shared_phone', severity: r.n >= 3 ? 'high' : 'medium', audience: 'security', entity: 'phone',
      fingerprint: `phone:${r.phone}:${r.n}`, title: `Phone ${r.phone} registered to ${r.n} people`, detail: r.names });
  }
  // 6. Mobile money paid from a number linked to a different identity (security)
  for (const r of all(`SELECT DISTINCT py.msisdn, ap.reference, p.full_name AS applicant, o.full_name AS owner
      FROM payments py JOIN applications ap ON ap.id = py.application_id JOIN persons p ON p.id = ap.person_id
      JOIN persons o ON o.phone = py.msisdn AND o.id <> ap.person_id
      WHERE py.status = 'paid' AND py.msisdn IS NOT NULL`)) {
    upsertAlert({ rule: 'third_party_payment', severity: 'low', audience: 'security', entity: 'phone',
      fingerprint: `tpp:${r.msisdn}:${r.reference}`, title: `${r.reference} paid from another person's number`,
      detail: `Applicant ${r.applicant}; paying number ${r.msisdn} belongs to ${r.owner}` });
  }
  // 7. High application volume from one identity (security) – 5+ in 7 days
  for (const r of all(`SELECT p.id, p.full_name, p.zan_id, COUNT(*) AS n FROM applications ap JOIN persons p ON p.id = ap.person_id
      WHERE ap.created_at >= datetime('now', '-7 days') GROUP BY p.id HAVING n >= 5`)) {
    upsertAlert({ rule: 'high_volume', severity: 'medium', audience: 'security', entity: 'person', entity_id: r.id,
      fingerprint: `vol:${r.id}:${new Date().toISOString().slice(0, 10)}`, title: `${r.full_name} filed ${r.n} applications in 7 days`, detail: `ZanID ${r.zan_id}` });
  }
  // 8. Paid but unreconciled > 2 days (finance)
  for (const r of all(`SELECT py.id, py.control_number, py.amount, py.application_id FROM payments py
      WHERE py.status = 'paid' AND py.reconciled = 0 AND julianday('now') - julianday(py.paid_at) > 2`)) {
    upsertAlert({ rule: 'unreconciled', severity: 'low', audience: 'finance', entity: 'application', entity_id: r.application_id,
      fingerprint: `unrec:${r.id}`, title: `Payment ${r.control_number} not reconciled`, detail: `TZS ${r.amount} paid more than 2 days ago` });
  }
  // auto-resolve application alerts for closed cases / answered referrals
  run(`UPDATE alerts SET status = 'resolved' WHERE status = 'open' AND rule IN ('sla_breach','sla_critical','escalated','referral_overdue')
       AND entity = 'application' AND entity_id IN (SELECT id FROM applications WHERE status NOT IN ${IN_OPEN})`);
  run(`UPDATE alerts SET status = 'resolved' WHERE status = 'open' AND rule = 'referral_overdue'
       AND CAST(substr(fingerprint, 5) AS INTEGER) IN (SELECT id FROM referrals WHERE status = 'answered')`);
  run(`UPDATE alerts SET status = 'resolved' WHERE status = 'open' AND rule = 'unreconciled'
       AND CAST(substr(fingerprint, 7) AS INTEGER) IN (SELECT id FROM payments WHERE reconciled = 1)`);
}

function metrics(agencyId = null) {
  const f = agencyId ? 'AND s.agency_id = ?' : '';
  const p = agencyId ? [agencyId] : [];
  const byStatus = Object.fromEntries(all(`SELECT ap.status, COUNT(*) AS n FROM applications ap JOIN services s ON s.id = ap.service_id
    WHERE 1=1 ${f} GROUP BY ap.status`, ...p).map((r) => [r.status, r.n]));
  const open = OPEN_STATUSES.reduce((t, s) => t + (byStatus[s] || 0), 0);
  const k = one(`SELECT
      SUM(CASE WHEN ap.status IN ${IN_OPEN} AND julianday('now') - julianday(ap.created_at) > s.sla_days THEN 1 ELSE 0 END) AS breaches,
      SUM(CASE WHEN ap.created_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS new_24h,
      SUM(CASE WHEN ap.status = 'issued' AND ap.closed_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS issued_30d,
      AVG(CASE WHEN ap.status = 'issued' THEN julianday(ap.closed_at) - julianday(ap.created_at) END) AS avg_days,
      SUM(CASE WHEN ap.status = 'issued' AND julianday(ap.closed_at) - julianday(ap.created_at) <= s.sla_days THEN 1 ELSE 0 END) AS on_time,
      SUM(CASE WHEN ap.status = 'issued' THEN 1 ELSE 0 END) AS issued_all,
      SUM(CASE WHEN ap.channel = 'desk' THEN 1 ELSE 0 END) AS desk, COUNT(*) AS total
    FROM applications ap JOIN services s ON s.id = ap.service_id WHERE 1=1 ${f}`, ...p);
  const rev = one(`SELECT COALESCE(SUM(py.amount),0) AS collected_30d FROM payments py JOIN applications ap ON ap.id = py.application_id
    JOIN services s ON s.id = ap.service_id WHERE py.status = 'paid' AND py.paid_at >= datetime('now','-30 days') ${f}`, ...p);
  const refQ = agencyId
    ? one("SELECT COUNT(*) AS n FROM referrals WHERE status = 'open' AND to_agency_id = ?", agencyId)
    : one("SELECT COUNT(*) AS n FROM referrals WHERE status = 'open'");
  const daily = all(`SELECT date(ap.created_at) AS day, COUNT(*) AS received,
      (SELECT COUNT(*) FROM applications a2 JOIN services s2 ON s2.id = a2.service_id WHERE a2.status='issued' AND date(a2.closed_at) = date(ap.created_at) ${agencyId ? 'AND s2.agency_id = ?' : ''}) AS issued
      FROM applications ap JOIN services s ON s.id = ap.service_id
      WHERE ap.created_at >= date('now','-13 days') ${f} GROUP BY day ORDER BY day`, ...(agencyId ? [agencyId, agencyId] : []));
  const byService = all(`SELECT s.name, s.sla_days, COUNT(*) AS total,
      SUM(CASE WHEN ap.status IN ${IN_OPEN} THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN ap.status IN ${IN_OPEN} AND julianday('now') - julianday(ap.created_at) > s.sla_days THEN 1 ELSE 0 END) AS breaches,
      ROUND(AVG(CASE WHEN ap.status='issued' THEN julianday(ap.closed_at)-julianday(ap.created_at) END),1) AS avg_days
      FROM applications ap JOIN services s ON s.id = ap.service_id WHERE 1=1 ${f} GROUP BY s.id ORDER BY total DESC`, ...p);
  return {
    by_status: byStatus, open, breaches: k.breaches || 0, new_24h: k.new_24h || 0, issued_30d: k.issued_30d || 0,
    avg_days: k.avg_days ? Math.round(k.avg_days * 10) / 10 : null,
    on_time_rate: k.issued_all ? Math.round((k.on_time / k.issued_all) * 100) : null,
    desk_share: k.total ? Math.round((k.desk / k.total) * 100) : 0, total: k.total || 0,
    collected_30d: rev.collected_30d, open_referrals: refQ.n, daily: fillDays(daily), by_service: byService,
  };
}
function fillDays(rows) {
  const map = Object.fromEntries(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    out.push({ day: d, received: map[d] ? map[d].received : 0, issued: map[d] ? map[d].issued : 0 });
  }
  return out;
}

function actionQueue(agencyId) {
  return all(`SELECT ap.id, ap.reference, ap.status, ap.escalated, s.name AS service, s.sla_days, p.full_name AS applicant,
      CAST(julianday('now') - julianday(ap.created_at) AS INTEGER) AS age_days, ag.name AS agency
      FROM applications ap JOIN services s ON s.id = ap.service_id JOIN persons p ON p.id = ap.person_id JOIN agencies ag ON ag.id = s.agency_id
      WHERE ap.status IN ${IN_OPEN} ${agencyId ? 'AND s.agency_id = ?' : ''}
      AND (julianday('now') - julianday(ap.created_at) > s.sla_days * 0.75 OR ap.escalated = 1)
      ORDER BY ap.escalated DESC, (julianday('now') - julianday(ap.created_at)) / s.sla_days DESC LIMIT 50`, ...(agencyId ? [agencyId] : []));
}

function ministryTable() {
  return all(`SELECT a.id, a.code, a.name,
      COUNT(ap.id) AS total,
      SUM(CASE WHEN ap.status IN ${IN_OPEN} THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN ap.status IN ${IN_OPEN} AND julianday('now') - julianday(ap.created_at) > s.sla_days THEN 1 ELSE 0 END) AS breaches,
      SUM(CASE WHEN ap.status='issued' THEN 1 ELSE 0 END) AS issued,
      ROUND(AVG(CASE WHEN ap.status='issued' THEN julianday(ap.closed_at)-julianday(ap.created_at) END),1) AS avg_days,
      (SELECT COUNT(*) FROM referrals r WHERE r.to_agency_id = a.id AND r.status='open') AS open_referrals,
      (SELECT COUNT(*) FROM alerts al WHERE al.agency_id = a.id AND al.status='open') AS open_alerts
      FROM agencies a LEFT JOIN services s ON s.agency_id = a.id LEFT JOIN applications ap ON ap.service_id = s.id
      GROUP BY a.id ORDER BY breaches DESC, open DESC`);
}

// Link analysis around a person, business or phone number
function links(q) {
  q = String(q || '').trim();
  if (!q) return null;
  let persons = all('SELECT * FROM persons WHERE zan_id = ? OR phone = ? OR full_name LIKE ? LIMIT 5', q, q.replace(/\D/g, '') || q, `%${q}%`);
  const biz = all('SELECT * FROM businesses WHERE brn = ? OR tin = ? OR name LIKE ? LIMIT 5', q, q, `%${q}%`);
  for (const b of biz) if (!persons.find((p) => p.id === b.owner_person_id)) persons.push(one('SELECT * FROM persons WHERE id = ?', b.owner_person_id));
  persons = persons.slice(0, 5);
  const nodes = []; const edges = []; const seen = new Set();
  const add = (id, type, label, extra = {}) => { if (!seen.has(id)) { seen.add(id); nodes.push({ id, type, label, ...extra }); } };
  for (const p of persons) {
    const pid = `p${p.id}`; add(pid, 'person', p.full_name, { zan_id: p.zan_id, phone: p.phone, district: p.district });
    if (p.phone) {
      add(`t${p.phone}`, 'phone', p.phone); edges.push({ from: pid, to: `t${p.phone}`, label: 'registered phone' });
      for (const o of all('SELECT * FROM persons WHERE phone = ? AND id <> ?', p.phone, p.id)) {
        add(`p${o.id}`, 'person', o.full_name, { zan_id: o.zan_id }); edges.push({ from: `p${o.id}`, to: `t${p.phone}`, label: 'registered phone' });
      }
      for (const py of all(`SELECT DISTINCT ap.reference, ap.id FROM payments py JOIN applications ap ON ap.id = py.application_id
          WHERE py.msisdn = ? AND ap.person_id <> ?`, p.phone, p.id)) {
        add(`a${py.id}`, 'application', py.reference); edges.push({ from: `t${p.phone}`, to: `a${py.id}`, label: 'paid for' });
      }
    }
    for (const b of all('SELECT * FROM businesses WHERE owner_person_id = ?', p.id)) {
      add(`b${b.id}`, 'business', b.name, { brn: b.brn, tin: b.tin }); edges.push({ from: pid, to: `b${b.id}`, label: 'owns' });
    }
    for (const a of all(`SELECT ap.id, ap.reference, ap.status, s.name FROM applications ap JOIN services s ON s.id = ap.service_id WHERE ap.person_id = ?`, p.id)) {
      add(`a${a.id}`, 'application', a.reference, { status: a.status, service: a.name }); edges.push({ from: pid, to: `a${a.id}`, label: 'applied' });
      for (const d of all('SELECT DISTINCT sha256 FROM documents WHERE application_id = ?', a.id)) {
        for (const other of all(`SELECT DISTINCT ap.id, ap.reference FROM documents d JOIN applications ap ON ap.id = d.application_id
            WHERE d.sha256 = ? AND ap.person_id <> ?`, d.sha256, p.id)) {
          add(`a${other.id}`, 'application', other.reference); edges.push({ from: `a${a.id}`, to: `a${other.id}`, label: 'same document file' });
        }
      }
    }
  }
  const alerts = all(`SELECT * FROM alerts WHERE status = 'open' AND audience = 'security' AND (detail LIKE ? OR title LIKE ?) LIMIT 20`, `%${q}%`, `%${q}%`);
  return { nodes, edges, alerts };
}

function snapshot() {
  const day = new Date().toISOString().slice(0, 10);
  const data = { metrics: metrics(), ministries: ministryTable(),
    alerts: one("SELECT COUNT(*) AS n FROM alerts WHERE status = 'open' AND severity = 'high'").n };
  run('INSERT INTO sip_snapshots(day, data) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET data = excluded.data, created_at = datetime(\'now\')', day, JSON.stringify(data));
  return { day, data };
}

module.exports = { sipEnabled, runRules, metrics, actionQueue, ministryTable, links, snapshot };
