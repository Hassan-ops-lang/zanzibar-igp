'use strict';
const crypto = require('node:crypto');
const { one, all, run, tx } = require('../db');
const { bad, forbidden, notFound, notifyPerson, newReference, newControlNumber, parse, nowSql, audit } = require('./core');
const { resolveRequiredDocs, recordsFor } = require('./records');

const OPEN_STATUSES = ['submitted', 'awaiting_applicant', 'in_review', 'awaiting_payment', 'approved'];
const STATUS_LABEL = {
  submitted: 'Submitted – awaiting front office check', awaiting_applicant: 'Action needed from applicant',
  in_review: 'Under review', awaiting_payment: 'Approved – awaiting payment', approved: 'Approved – awaiting issuance',
  issued: 'Issued', rejected: 'Rejected', withdrawn: 'Withdrawn',
};

function event(appId, kind, message, req, { internal = false } = {}) {
  run('INSERT INTO application_events(application_id, kind, message, actor_id, agency_id, visible_to_applicant) VALUES(?,?,?,?,?,?)',
    appId, kind, message, req && req.user ? req.user.id : null, req && req.user ? req.user.agency_id : null, internal ? 0 : 1);
  run("UPDATE applications SET updated_at = datetime('now') WHERE id = ?", appId);
}

function getApp(id) {
  const a = one(`SELECT ap.*, s.code AS service_code, s.name AS service_name, s.agency_id AS service_agency_id, s.fee,
      s.sla_days, s.required_docs, s.referral_agencies, s.output_name, s.output_validity_days, s.subject,
      ag.name AS agency_name, ag.code AS agency_code, p.full_name AS applicant_name, p.zan_id, p.phone AS applicant_phone,
      b.name AS business_name, b.brn
      FROM applications ap JOIN services s ON s.id = ap.service_id JOIN agencies ag ON ag.id = s.agency_id
      JOIN persons p ON p.id = ap.person_id LEFT JOIN businesses b ON b.id = ap.business_id
      WHERE ap.id = ? OR ap.reference = ?`, Number(id) || -1, String(id));
  if (!a) throw notFound('Application not found');
  return a;
}

// Who may see an application
function canView(user, app) {
  if (!user) return false;
  if (user.role === 'citizen') return app.person_id === user.person_id;
  if (['admin', 'executive', 'security'].includes(user.role)) return true;
  if (user.role === 'finance') return true;
  if (app.service_agency_id === user.agency_id) return true;
  // agencies that received a referral on the case
  return !!one('SELECT 1 FROM referrals WHERE application_id = ? AND to_agency_id = ?', app.id, user.agency_id);
}
function assertView(user, app) { if (!canView(user, app)) throw forbidden(); }
function assertOwningAgency(user, app, roles) {
  if (user.role === 'admin') return;
  if (!roles.includes(user.role) || user.agency_id !== app.service_agency_id) throw forbidden('Only the responsible office can do this');
}

function submit(req, { serviceId, personId, businessId, formData, channel }) {
  const svc = one('SELECT * FROM services WHERE id = ? AND active = 1', serviceId);
  if (!svc) throw bad('Service not available');
  const person = one('SELECT * FROM persons WHERE id = ?', personId);
  if (!person) throw bad('Applicant not found in civil registry');
  let business = null;
  if (svc.subject === 'business') {
    business = one('SELECT * FROM businesses WHERE id = ?', businessId);
    if (!business) throw bad('Select the business this application is for');
    if (business.owner_person_id !== person.id) throw forbidden('Only the registered owner can apply for this business');
  }
  // validate the form against the service schema
  const schema = parse(svc.form_schema, []);
  const clean = {};
  for (const f of schema) {
    let v = formData ? formData[f.name] : undefined;
    if (typeof v === 'string') v = v.trim();
    if (f.required && (v === undefined || v === null || v === '')) throw bad(`${f.label} is required`);
    if (v !== undefined && v !== '') {
      if (f.type === 'number' && Number.isNaN(Number(v))) throw bad(`${f.label} must be a number`);
      if (f.type === 'select' && f.options && !f.options.includes(v)) throw bad(`${f.label}: invalid choice`);
      clean[f.name] = f.type === 'number' ? Number(v) : v;
    }
  }
  const docs = resolveRequiredDocs(svc, person.id, business && business.id);
  const reused = docs.filter((d) => d.satisfied_by_record).map((d) => ({ code: d.code, label: d.label, ...d.satisfied_by_record }));

  return tx(() => {
    const dup = one(`SELECT reference FROM applications WHERE service_id = ? AND person_id = ? AND COALESCE(business_id,0) = ?
      AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`, svc.id, person.id, business ? business.id : 0, ...OPEN_STATUSES);
    if (dup) throw bad(`An application for this service is already open (${dup.reference})`);
    const ref = newReference();
    const r = run(`INSERT INTO applications(reference, service_id, person_id, business_id, submitted_by, channel, form_data, reused_records)
      VALUES(?,?,?,?,?,?,?,?)`, ref, svc.id, person.id, business ? business.id : null, req.user.id, channel,
    JSON.stringify(clean), JSON.stringify(reused));
    const appId = Number(r.lastInsertRowid);
    if (svc.fee > 0) run('INSERT INTO payments(application_id, control_number, amount) VALUES(?,?,?)', appId, newControlNumber(), svc.fee);
    event(appId, 'submitted', channel === 'desk'
      ? `Submitted at the ${req.user.agency_name || 'government'} service desk on behalf of the applicant`
      : 'Application submitted online', req);
    if (reused.length) event(appId, 'records_reused', `Verified records reused: ${reused.map((x) => x.label).join(', ')}`, req);
    notifyPerson(person.id, appId, `Your application ${ref} for ${svc.name} was received. Track it with reference ${ref}.`);
    audit(req, 'application.submit', 'application', appId, { reference: ref, service: svc.code, channel });
    return { id: appId, reference: ref };
  });
}

function missingDocs(app) {
  const docs = resolveRequiredDocsForApp(app);
  return docs.filter((d) => !d.satisfied_by_record && !d.uploaded);
}
function resolveRequiredDocsForApp(app) {
  const reused = parse(app.reused_records, []);
  const required = parse(app.required_docs, []);
  const uploaded = all('SELECT doc_code, status FROM documents WHERE application_id = ?', app.id);
  return required.map((d) => ({
    ...d,
    satisfied_by_record: reused.find((r) => r.code === d.code) || null,
    uploaded: uploaded.some((u) => u.doc_code === d.code && u.status !== 'rejected'),
  }));
}

function requestDocument(req, app, { doc_code, label, message }) {
  assertOwningAgency(req.user, app, ['front_office', 'back_office']);
  if (!['submitted', 'in_review', 'awaiting_applicant'].includes(app.status)) throw bad('Documents cannot be requested at this stage');
  if (!doc_code || !label) throw bad('Choose the document to request');
  tx(() => {
    run('INSERT INTO document_requests(application_id, doc_code, label, message, requested_by) VALUES(?,?,?,?,?)',
      app.id, doc_code, label, message || null, req.user.id);
    run("UPDATE applications SET status = 'awaiting_applicant' WHERE id = ?", app.id);
    event(app.id, 'document_requested', `Document requested: ${label}${message ? ` – ${message}` : ''}`, req);
  });
  notifyPerson(app.person_id, app.id, `${app.reference}: please upload "${label}" in the portal to continue your application.`);
  audit(req, 'application.request_document', 'application', app.id, { doc_code, label });
}

function afterUpload(req, app, docCode) {
  const reqs = all("SELECT * FROM document_requests WHERE application_id = ? AND doc_code = ? AND status = 'open'", app.id, docCode);
  for (const r of reqs) run("UPDATE document_requests SET status = 'fulfilled', fulfilled_at = datetime('now') WHERE id = ?", r.id);
  const open = one("SELECT COUNT(*) AS n FROM document_requests WHERE application_id = ? AND status = 'open'", app.id).n;
  if (app.status === 'awaiting_applicant' && open === 0) {
    // return the case to whichever stage requested it
    const back = one("SELECT kind FROM application_events WHERE application_id = ? AND kind IN ('routed','submitted') ORDER BY id DESC LIMIT 1", app.id);
    const next = back && back.kind === 'routed' ? 'in_review' : 'submitted';
    run('UPDATE applications SET status = ? WHERE id = ?', next, app.id);
    event(app.id, 'resumed', 'All requested documents received – case returned to the office', req);
  }
}

// Front office accepts the submission and routes it to the back office (and referral agencies)
function route(req, app, { assign_to, note }) {
  assertOwningAgency(req.user, app, ['front_office', 'back_office']);
  if (app.status !== 'submitted') throw bad('Only newly submitted cases can be routed');
  const missing = missingDocs(app);
  if (missing.length) throw bad(`Missing documents: ${missing.map((d) => d.label).join(', ')}. Request them from the applicant first.`);
  if (assign_to) {
    const u = one("SELECT id FROM users WHERE id = ? AND role = 'back_office' AND agency_id = ?", assign_to, app.service_agency_id);
    if (!u) throw bad('Assignee must be a back office officer of this agency');
  }
  tx(() => {
    run("UPDATE applications SET status = 'in_review', assigned_to = ? WHERE id = ?", assign_to || null, app.id);
    event(app.id, 'routed', `Submission checked and routed for review${note ? ` – ${note}` : ''}`, req);
    const agencies = parse(app.referral_agencies, []);
    for (const code of agencies) {
      const ag = one('SELECT id, name FROM agencies WHERE code = ?', code);
      if (!ag) continue;
      if (one("SELECT 1 FROM referrals WHERE application_id = ? AND to_agency_id = ? AND status = 'open'", app.id, ag.id)) continue;
      run('INSERT INTO referrals(application_id, from_agency_id, to_agency_id, question, created_by) VALUES(?,?,?,?,?)',
        app.id, app.service_agency_id, ag.id, `Standard ${app.service_name} clearance`, req.user.id);
      event(app.id, 'referred', `Referred to ${ag.name} for clearance`, req);
    }
  });
  notifyPerson(app.person_id, app.id, `${app.reference}: your application is now under review.`);
  audit(req, 'application.route', 'application', app.id, { assign_to });
}

function refer(req, app, { to_agency_id, question }) {
  assertOwningAgency(req.user, app, ['back_office', 'front_office']);
  if (!['in_review', 'submitted'].includes(app.status)) throw bad('Referrals can only be made while the case is open for review');
  const ag = one('SELECT * FROM agencies WHERE id = ?', to_agency_id);
  if (!ag || ag.id === app.service_agency_id) throw bad('Choose another agency');
  if (!question) throw bad('State what you need from the other office');
  run('INSERT INTO referrals(application_id, from_agency_id, to_agency_id, question, created_by) VALUES(?,?,?,?,?)',
    app.id, app.service_agency_id, ag.id, question, req.user.id);
  event(app.id, 'referred', `Referred to ${ag.name}`, req);
  audit(req, 'referral.create', 'application', app.id, { to: ag.code });
}

function answerReferral(req, referralId, { outcome, note }) {
  const r = one('SELECT * FROM referrals WHERE id = ?', referralId);
  if (!r) throw notFound('Referral not found');
  if (req.user.role !== 'admin' && (req.user.agency_id !== r.to_agency_id || !['back_office', 'front_office'].includes(req.user.role))) throw forbidden();
  if (r.status !== 'open') throw bad('Referral already answered');
  if (!['cleared', 'objection'].includes(outcome)) throw bad('Outcome must be cleared or objection');
  if (outcome === 'objection' && !note) throw bad('Explain the objection');
  run("UPDATE referrals SET status = 'answered', outcome = ?, note = ?, responded_by = ?, responded_at = datetime('now') WHERE id = ?",
    outcome, note || null, req.user.id, r.id);
  const ag = one('SELECT name FROM agencies WHERE id = ?', r.to_agency_id);
  event(r.application_id, 'referral_answered', `${ag.name}: ${outcome === 'cleared' ? 'cleared' : 'raised an objection'}${note ? ` – ${note}` : ''}`, req);
  audit(req, 'referral.answer', 'referral', r.id, { outcome });
}

function approve(req, app, { note }) {
  assertOwningAgency(req.user, app, ['back_office']);
  if (app.status !== 'in_review') throw bad('Only cases under review can be approved');
  const open = one("SELECT COUNT(*) AS n FROM referrals WHERE application_id = ? AND status = 'open'", app.id).n;
  if (open) throw bad(`${open} referral(s) still awaiting a response`);
  const obj = one("SELECT COUNT(*) AS n FROM referrals WHERE application_id = ? AND outcome = 'objection'", app.id).n;
  if (obj && !note) throw bad('A referral raised an objection – record how it was resolved in the note');
  const openReq = one("SELECT COUNT(*) AS n FROM document_requests WHERE application_id = ? AND status = 'open'", app.id).n;
  if (openReq) throw bad('Document requests are still open');
  const pay = one('SELECT * FROM payments WHERE application_id = ?', app.id);
  const next = !pay || pay.status === 'paid' ? 'approved' : 'awaiting_payment';
  run('UPDATE applications SET status = ?, decision_note = ? WHERE id = ?', next, note || null, app.id);
  event(app.id, 'approved', `Application approved${note ? ` – ${note}` : ''}`, req);
  if (next === 'awaiting_payment') {
    notifyPerson(app.person_id, app.id, `${app.reference} approved. Pay TZS ${pay.amount.toLocaleString()} with control number ${pay.control_number} to receive your ${app.output_name || 'document'}.`);
  } else {
    notifyPerson(app.person_id, app.id, `${app.reference} approved. Your ${app.output_name || 'document'} is being issued.`);
  }
  audit(req, 'application.approve', 'application', app.id, { next });
}

function reject(req, app, { note }) {
  assertOwningAgency(req.user, app, ['back_office']);
  if (!OPEN_STATUSES.includes(app.status)) throw bad('Case is already closed');
  if (!note) throw bad('Give the reason for rejection');
  run("UPDATE applications SET status = 'rejected', decision_note = ?, closed_at = datetime('now') WHERE id = ?", note, app.id);
  event(app.id, 'rejected', `Application rejected – ${note}`, req);
  notifyPerson(app.person_id, app.id, `${app.reference} was not approved: ${note}`);
  audit(req, 'application.reject', 'application', app.id);
}

function onPaid(appId, req, method = 'mobile money') {
  const app = getApp(appId);
  event(app.id, 'paid', `Fee paid by ${method} – receipt issued`, req);
  if (app.status === 'awaiting_payment') {
    run("UPDATE applications SET status = 'approved' WHERE id = ?", app.id);
    event(app.id, 'ready', 'Payment confirmed – ready for issuance', req, { internal: true });
  }
}

function issue(req, app) {
  assertOwningAgency(req.user, app, ['back_office']);
  if (app.status !== 'approved') throw bad(app.status === 'awaiting_payment' ? 'Fee has not been paid yet' : 'Case must be approved first');
  const pay = one('SELECT status FROM payments WHERE application_id = ?', app.id);
  if (pay && pay.status !== 'paid') throw bad('Fee has not been paid yet');
  const svc = one('SELECT * FROM services WHERE id = ?', app.service_id);
  const number = `${svc.code}/${new Date().getFullYear()}/${String(app.id).padStart(6, '0')}`;
  const code = crypto.randomBytes(6).toString('hex').toUpperCase();
  const validUntil = svc.output_validity_days
    ? new Date(Date.now() + svc.output_validity_days * 864e5).toISOString().slice(0, 10) : null;
  const data = {
    reference: app.reference, holder: app.applicant_name, zan_id: app.zan_id, business: app.business_name, brn: app.brn,
    service: svc.name, agency: app.agency_name, form: parse(app.form_data, {}),
  };
  tx(() => {
    run(`INSERT INTO issued_documents(application_id, number, title, verification_code, data, issued_by, valid_until)
      VALUES(?,?,?,?,?,?,?)`, app.id, number, svc.output_name || svc.name, code, JSON.stringify(data), req.user.id, validUntil);
    // the issued document becomes a verified record reusable across government
    run(`INSERT OR IGNORE INTO record_types(code, name, owner_agency_id) VALUES(?,?,?)`, svc.code.toLowerCase(), svc.output_name || svc.name, svc.agency_id);
    run(`INSERT INTO records(record_type, person_id, business_id, issuing_agency_id, number, data, valid_until)
      VALUES(?,?,?,?,?,?,?)`, svc.code.toLowerCase(), app.business_id ? null : app.person_id, app.business_id, svc.agency_id,
    number, JSON.stringify({ reference: app.reference }), validUntil);
    run("UPDATE applications SET status = 'issued', closed_at = datetime('now') WHERE id = ?", app.id);
    event(app.id, 'issued', `${svc.output_name || 'Document'} ${number} issued under reference ${app.reference}`, req);
  });
  notifyPerson(app.person_id, app.id, `${app.reference}: your ${svc.output_name || 'document'} ${number} is ready to download in the portal.`);
  audit(req, 'application.issue', 'application', app.id, { number });
  return { number, verification_code: code };
}

function withdraw(req, app) {
  if (req.user.role !== 'citizen' || req.user.person_id !== app.person_id) throw forbidden();
  if (!['submitted', 'awaiting_applicant', 'in_review'].includes(app.status)) throw bad('This application can no longer be withdrawn');
  run("UPDATE applications SET status = 'withdrawn', closed_at = datetime('now') WHERE id = ?", app.id);
  event(app.id, 'withdrawn', 'Withdrawn by applicant', req);
  audit(req, 'application.withdraw', 'application', app.id);
}

function detail(user, app) {
  const isCitizen = user.role === 'citizen';
  const events = all(`SELECT e.*, u.full_name AS actor_name, a.name AS agency_name FROM application_events e
    LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN agencies a ON a.id = e.agency_id
    WHERE application_id = ? ${isCitizen ? 'AND visible_to_applicant = 1' : ''} ORDER BY e.id`, app.id);
  const documents = all('SELECT id, doc_code, filename, mime, size, sha256, status, created_at FROM documents WHERE application_id = ? ORDER BY id', app.id);
  const requests = all('SELECT * FROM document_requests WHERE application_id = ? ORDER BY id', app.id);
  const referrals = all(`SELECT r.*, fa.name AS from_agency, ta.name AS to_agency, u.full_name AS responded_by_name FROM referrals r
    JOIN agencies fa ON fa.id = r.from_agency_id JOIN agencies ta ON ta.id = r.to_agency_id LEFT JOIN users u ON u.id = r.responded_by
    WHERE application_id = ? ORDER BY r.id`, app.id);
  const payment = one('SELECT * FROM payments WHERE application_id = ?', app.id);
  const issued = one('SELECT id, number, title, verification_code, issued_at, valid_until, revoked FROM issued_documents WHERE application_id = ?', app.id);
  const out = {
    ...app, form_data: parse(app.form_data, {}), reused_records: parse(app.reused_records, []),
    referral_agencies: parse(app.referral_agencies, []), required_docs: resolveRequiredDocsForApp(app),
    status_label: STATUS_LABEL[app.status] || app.status, events, documents, requests,
    referrals: isCitizen ? referrals.map((r) => ({ id: r.id, to_agency: r.to_agency, status: r.status, outcome: r.outcome, created_at: r.created_at, responded_at: r.responded_at })) : referrals,
    payment, issued,
    sla_due: new Date(new Date(app.created_at.replace(' ', 'T') + 'Z').getTime() + app.sla_days * 864e5).toISOString(),
  };
  delete out.required_docs_raw;
  if (!isCitizen) {
    const agencyId = ['admin', 'executive', 'security'].includes(user.role) ? app.service_agency_id : user.agency_id;
    out.verified_records = recordsFor({ personId: app.person_id, businessId: app.business_id, agencyId });
    out.assignee = app.assigned_to ? one('SELECT id, full_name FROM users WHERE id = ?', app.assigned_to) : null;
  }
  return out;
}

module.exports = {
  OPEN_STATUSES, STATUS_LABEL, getApp, canView, assertView, submit, requestDocument, afterUpload, route, refer,
  answerReferral, approve, reject, issue, onPaid, withdraw, detail, event, missingDocs, nowSql,
};
