'use strict';
const express = require('express');
const { one, all, run } = require('../db');
const { bad, forbidden, HttpError, audit, parse } = require('../lib/core');
const { requireRole } = require('../lib/auth');
const sip = require('../lib/sip');

const r = express.Router();
r.use(requireRole('ministry_leader', 'security', 'executive', 'admin'));
r.use((_req, _res, next) => next(sip.sipEnabled() ? undefined : new HttpError(409, 'SIP starts after all three IGP integration phases are live')));
r.use((req, _res, next) => { audit(req, 'sip.access', 'sip', req.path, req.method === 'GET' ? req.query : null, req.query.purpose || null); next(); });

function alertsFor(user, status = 'open') {
  const st = status === 'all' ? '' : 'AND al.status = ?';
  const sp = status === 'all' ? [] : [status];
  const base = `SELECT al.*, a.name AS agency FROM alerts al LEFT JOIN agencies a ON a.id = al.agency_id WHERE 1=1 ${st}`;
  if (user.role === 'ministry_leader') return all(`${base} AND al.audience = 'ministry' AND al.agency_id = ? ORDER BY al.id DESC LIMIT 200`, ...sp, user.agency_id);
  if (user.role === 'security') return all(`${base} AND al.audience = 'security' ORDER BY al.id DESC LIMIT 200`, ...sp);
  if (user.role === 'executive') return all(`${base} AND (al.audience = 'executive' OR (al.severity = 'high' AND al.audience <> 'security')) ORDER BY al.id DESC LIMIT 200`, ...sp);
  return all(`${base} ORDER BY al.id DESC LIMIT 200`, ...sp);
}

r.get('/overview', (req, res) => {
  const u = req.user;
  if (u.role === 'ministry_leader') {
    return res.json({ scope: 'ministry', agency: u.agency_name, metrics: sip.metrics(u.agency_id), queue: sip.actionQueue(u.agency_id), alerts: alertsFor(u) });
  }
  if (u.role === 'security') {
    const alerts = alertsFor(u);
    const byRule = all("SELECT rule, COUNT(*) AS n FROM alerts WHERE audience = 'security' AND status = 'open' GROUP BY rule ORDER BY n DESC");
    return res.json({ scope: 'security', alerts, by_rule: byRule });
  }
  const snap = one('SELECT * FROM sip_snapshots ORDER BY day DESC LIMIT 1');
  res.json({
    scope: 'executive', metrics: sip.metrics(), ministries: sip.ministryTable(), queue: sip.actionQueue(null), alerts: alertsFor(u),
    snapshot: snap ? { day: snap.day, created_at: snap.created_at } : null,
    security_summary: one("SELECT COUNT(*) AS open, SUM(CASE WHEN severity='high' THEN 1 ELSE 0 END) AS high FROM alerts WHERE audience='security' AND status='open'"),
  });
});

r.get('/ministry/:id', requireRole('executive', 'admin'), (req, res) => {
  const a = one('SELECT * FROM agencies WHERE id = ?', req.params.id);
  if (!a) throw bad('Unknown ministry');
  res.json({ agency: a.name, metrics: sip.metrics(a.id), queue: sip.actionQueue(a.id),
    alerts: all("SELECT * FROM alerts WHERE agency_id = ? AND status = 'open' ORDER BY id DESC", a.id) });
});

r.get('/alerts', (req, res) => res.json(alertsFor(req.user, req.query.status || 'open')));

r.post('/alerts/:id/ack', (req, res) => {
  const al = one('SELECT * FROM alerts WHERE id = ?', req.params.id);
  if (!al) throw bad('Unknown alert');
  if (!alertsFor(req.user, 'all').some((x) => x.id === al.id)) throw forbidden();
  const status = req.body.status === 'dismissed' ? 'dismissed' : 'acknowledged';
  run("UPDATE alerts SET status = ?, ack_by = ?, ack_at = datetime('now') WHERE id = ?", status, req.user.id, al.id);
  audit(req, 'sip.alert_' + status, 'alert', al.id, req.body.note || null);
  res.json({ ok: true });
});

// Link analysis – security services only, purpose is mandatory and logged
r.get('/links', requireRole('security'), (req, res) => {
  if (!req.query.purpose || String(req.query.purpose).trim().length < 5) throw bad('State the purpose of this search (case or file number)');
  const out = sip.links(req.query.q);
  if (!out) throw bad('Enter a ZanID, BRN, TIN, phone number or name');
  audit(req, 'sip.link_search', 'query', req.query.q, { nodes: out.nodes.length }, String(req.query.purpose));
  res.json(out);
});

r.get('/snapshots', requireRole('executive', 'admin'), (_req, res) => {
  res.json(all('SELECT day, data FROM sip_snapshots ORDER BY day DESC LIMIT 30').map((s) => {
    const d = parse(s.data, {});
    return { day: s.day, open: d.metrics && d.metrics.open, breaches: d.metrics && d.metrics.breaches, issued_30d: d.metrics && d.metrics.issued_30d, high_alerts: d.alerts };
  }));
});

r.post('/refresh', (req, res) => {
  sip.runRules();
  if (['executive', 'admin'].includes(req.user.role)) sip.snapshot();
  res.json({ ok: true });
});

module.exports = r;
