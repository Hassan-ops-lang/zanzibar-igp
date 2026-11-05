'use strict';
/*
 * Inter-agency integration API (Phase 1). Each ministry/department/agency system authenticates with its own
 * API key (header X-API-Key) and can only read the verified record types it has been granted. Every call is audited.
 */
const express = require('express');
const { one, all, run } = require('../db');
const { bad, forbidden, notFound, audit, parse } = require('../lib/core');
const { requireApiKey } = require('../lib/auth');
const { recordsFor, canAccess } = require('../lib/records');
const wf = require('../lib/workflow');

const r = express.Router();
r.use(requireApiKey);

r.get('/whoami', (req, res) => res.json({ agency: req.apiAgency,
  can_read: all('SELECT record_type FROM record_access_grants WHERE agency_id = ?', req.apiAgency.id).map((g) => g.record_type),
  owns: all('SELECT code FROM record_types WHERE owner_agency_id = ?', req.apiAgency.id).map((t) => t.code) }));

r.get('/persons/:zan_id', (req, res) => {
  const p = one('SELECT id, zan_id, full_name, dob, sex, district FROM persons WHERE zan_id = ?', req.params.zan_id);
  if (!p) throw notFound('Person not found');
  const records = recordsFor({ personId: p.id, agencyId: req.apiAgency.id });
  audit(req, 'xapi.person_read', 'person', p.id, { records: records.length }, req.headers['x-purpose'] || null);
  res.json({ person: p, records });
});

r.get('/businesses/:brn', (req, res) => {
  const b = one('SELECT id, brn, name, tin, sector, address, owner_person_id, registered_at FROM businesses WHERE brn = ?', req.params.brn);
  if (!b) throw notFound('Business not found');
  const owner = one('SELECT zan_id, full_name FROM persons WHERE id = ?', b.owner_person_id);
  const records = recordsFor({ businessId: b.id, agencyId: req.apiAgency.id });
  audit(req, 'xapi.business_read', 'business', b.id, { records: records.length }, req.headers['x-purpose'] || null);
  delete b.owner_person_id;
  res.json({ business: { ...b, owner }, records });
});

// An agency publishes a verified record it is the owner of (e.g. ZRB publishes tax clearances)
r.post('/records', (req, res) => {
  const b = req.body;
  const t = one('SELECT * FROM record_types WHERE code = ?', b.record_type);
  if (!t) throw bad('Unknown record_type');
  if (t.owner_agency_id !== req.apiAgency.id) throw forbidden('Only the owning agency can publish this record type');
  let personId = null; let businessId = null;
  if (b.zan_id) { const p = one('SELECT id FROM persons WHERE zan_id = ?', b.zan_id); if (!p) throw bad('Unknown zan_id'); personId = p.id; }
  if (b.brn) { const x = one('SELECT id FROM businesses WHERE brn = ?', b.brn); if (!x) throw bad('Unknown brn'); businessId = x.id; }
  if (!personId && !businessId) throw bad('Provide zan_id or brn');
  const i = run('INSERT INTO records(record_type, person_id, business_id, issuing_agency_id, number, data, valid_until, status) VALUES(?,?,?,?,?,?,?,?)',
    t.code, personId, businessId, req.apiAgency.id, b.number || null, JSON.stringify(b.data || {}), b.valid_until || null, b.status === 'revoked' ? 'revoked' : 'valid');
  audit(req, 'xapi.record_publish', 'record', i.lastInsertRowid, { record_type: t.code });
  res.status(201).json({ id: Number(i.lastInsertRowid) });
});
r.patch('/records/:id', (req, res) => {
  const rec = one('SELECT * FROM records WHERE id = ?', req.params.id);
  if (!rec) throw notFound();
  if (rec.issuing_agency_id !== req.apiAgency.id) throw forbidden();
  run('UPDATE records SET status = COALESCE(?, status), valid_until = COALESCE(?, valid_until) WHERE id = ?', req.body.status || null, req.body.valid_until || null, rec.id);
  audit(req, 'xapi.record_update', 'record', rec.id, req.body);
  res.json({ ok: true });
});

// Civil registry and business registry feeds
r.post('/persons', (req, res) => {
  if (!canAccess(req.apiAgency.id, 'national_id') || one('SELECT owner_agency_id FROM record_types WHERE code = ?', 'national_id').owner_agency_id !== req.apiAgency.id) throw forbidden('Only the civil registry can register persons');
  const b = req.body;
  if (!b.zan_id || !b.full_name || !b.dob) throw bad('zan_id, full_name and dob required');
  const phone = b.phone ? require('../lib/payments').normaliseMsisdn(b.phone) : null;
  run(`INSERT INTO persons(zan_id, full_name, dob, sex, phone, address, district) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(zan_id) DO UPDATE SET full_name=excluded.full_name, dob=excluded.dob, sex=excluded.sex, phone=excluded.phone, address=excluded.address, district=excluded.district`,
  b.zan_id, b.full_name, b.dob, b.sex || null, phone, b.address || null, b.district || null);
  const p = one('SELECT id FROM persons WHERE zan_id = ?', b.zan_id);
  if (!one("SELECT 1 FROM records WHERE person_id = ? AND record_type = 'national_id'", p.id)) {
    run("INSERT INTO records(record_type, person_id, issuing_agency_id, number) VALUES('national_id', ?, ?, ?)", p.id, req.apiAgency.id, b.zan_id);
  }
  audit(req, 'xapi.person_upsert', 'person', p.id);
  res.status(201).json({ id: p.id });
});
r.post('/businesses', (req, res) => {
  const t = one("SELECT owner_agency_id FROM record_types WHERE code = 'business_registration'");
  if (!t || t.owner_agency_id !== req.apiAgency.id) throw forbidden('Only the business registry can register businesses');
  const b = req.body;
  const owner = one('SELECT id FROM persons WHERE zan_id = ?', b.owner_zan_id);
  if (!owner || !b.brn || !b.name) throw bad('brn, name and a known owner_zan_id required');
  run(`INSERT INTO businesses(brn, name, owner_person_id, tin, sector, address, phone) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(brn) DO UPDATE SET name=excluded.name, tin=excluded.tin, sector=excluded.sector, address=excluded.address, phone=excluded.phone`,
  b.brn, b.name, owner.id, b.tin || null, b.sector || null, b.address || null, b.phone || null);
  const biz = one('SELECT id FROM businesses WHERE brn = ?', b.brn);
  if (!one("SELECT 1 FROM records WHERE business_id = ? AND record_type = 'business_registration'", biz.id)) {
    run("INSERT INTO records(record_type, business_id, issuing_agency_id, number, data) VALUES('business_registration', ?, ?, ?, ?)",
      biz.id, req.apiAgency.id, b.brn, JSON.stringify({ name: b.name, sector: b.sector }));
  }
  audit(req, 'xapi.business_upsert', 'business', biz.id);
  res.status(201).json({ id: biz.id });
});

// Referrals: other agencies' systems receive and answer referrals digitally
r.get('/referrals', (req, res) => {
  res.json(all(`SELECT rf.id, rf.question, rf.status, rf.outcome, rf.created_at, ap.reference, s.name AS service, fa.code AS from_agency,
      pe.zan_id, b.brn FROM referrals rf JOIN applications ap ON ap.id = rf.application_id JOIN services s ON s.id = ap.service_id
      JOIN agencies fa ON fa.id = rf.from_agency_id JOIN persons pe ON pe.id = ap.person_id LEFT JOIN businesses b ON b.id = ap.business_id
      WHERE rf.to_agency_id = ? AND (? = 'all' OR rf.status = ?) ORDER BY rf.id`, req.apiAgency.id, req.query.status || 'open', req.query.status || 'open'));
});
r.post('/referrals/:id/answer', (req, res) => {
  const rf = one('SELECT * FROM referrals WHERE id = ?', req.params.id);
  if (!rf || rf.to_agency_id !== req.apiAgency.id) throw notFound('Referral not found');
  // reuse the workflow with a synthetic system actor for this agency
  wf.answerReferral({ ...req, user: { id: null, role: 'admin', agency_id: req.apiAgency.id, username: `api:${req.apiAgency.code}` } }, rf.id, req.body);
  res.json({ ok: true });
});

r.get('/applications/:reference', (req, res) => {
  const app = wf.getApp(req.params.reference);
  const involved = app.service_agency_id === req.apiAgency.id || one('SELECT 1 FROM referrals WHERE application_id = ? AND to_agency_id = ?', app.id, req.apiAgency.id);
  if (!involved) throw forbidden();
  audit(req, 'xapi.application_read', 'application', app.id);
  res.json({ reference: app.reference, service: app.service_name, status: app.status, status_label: wf.STATUS_LABEL[app.status],
    created_at: app.created_at, updated_at: app.updated_at, form: parse(app.form_data, {}) });
});

module.exports = r;
