'use strict';
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const { one, all, run, DATA_DIR } = require('../db');
const { bad, forbidden, notFound, audit, parse, STAFF } = require('../lib/core');
const { requireAuth, requireRole } = require('../lib/auth');
const wf = require('../lib/workflow');
const { resolveRequiredDocs, recordsFor, personProfile } = require('../lib/records');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_q, f, cb) => cb(null, crypto.randomBytes(16).toString('hex') + (ALLOWED[f.mimetype] || '')),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 12 },
  fileFilter: (_q, f, cb) => (ALLOWED[f.mimetype] ? cb(null, true) : cb(bad(`${f.originalname}: only PDF, JPG or PNG files are accepted`))),
});

function storeFile(req, appId, docCode, f) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex');
  const info = run('INSERT INTO documents(application_id, doc_code, filename, stored_name, mime, size, sha256, uploaded_by) VALUES(?,?,?,?,?,?,?,?)',
    appId, docCode, f.originalname.slice(0, 200), f.filename, f.mimetype, f.size, hash, req.user.id);
  audit(req, 'document.upload', 'document', info.lastInsertRowid, { application_id: appId, doc_code: docCode, sha256: hash });
  return Number(info.lastInsertRowid);
}

const r = express.Router();
r.use(requireAuth);

// ---------- catalogue ----------
r.get('/agencies', (_req, res) => res.json(all('SELECT id, code, name, kind, integrated FROM agencies ORDER BY name')));

r.get('/services', (_req, res) => {
  res.json(all(`SELECT s.id, s.code, s.name, s.description, s.fee, s.subject, s.sla_days, s.origin, s.output_name, s.agency_id, a.name AS agency
    FROM services s JOIN agencies a ON a.id = s.agency_id WHERE s.active = 1 ORDER BY a.name, s.name`));
});

r.get('/services/:id', (req, res) => {
  const s = one('SELECT s.*, a.name AS agency FROM services s JOIN agencies a ON a.id = s.agency_id WHERE s.id = ?', req.params.id);
  if (!s) throw notFound();
  const personId = req.user.role === 'citizen' ? req.user.person_id : Number(req.query.person_id) || null;
  const out = { ...s, form_schema: parse(s.form_schema, []), required_docs: parse(s.required_docs, []), referral_agencies: parse(s.referral_agencies, []) };
  if (personId) {
    out.resolved_docs = resolveRequiredDocs(s, personId, Number(req.query.business_id) || null);
    // pre-fill form values from verified records the applicant already holds
    const person = personProfile(personId);
    const biz = person && person.businesses.find((b) => b.id === Number(req.query.business_id));
    const src = { person, business: biz };
    out.prefill = {};
    for (const f of out.form_schema) {
      if (!f.prefill) continue;
      const [obj, key] = f.prefill.split('.');
      if (src[obj] && src[obj][key] != null) out.prefill[f.name] = src[obj][key];
    }
  }
  res.json(out);
});

// ---------- people (front office lookup for assisted applications) ----------
r.get('/persons/lookup', requireRole('front_office', 'back_office', 'admin'), (req, res) => {
  const zan = String(req.query.zan_id || '').trim();
  const p = one('SELECT id FROM persons WHERE zan_id = ?', zan);
  if (!p) throw notFound('No one with that ZanID in the civil registry');
  audit(req, 'person.lookup', 'person', p.id, null, 'assisted application');
  res.json(personProfile(p.id));
});

r.get('/me/records', requireRole('citizen'), (req, res) => {
  res.json({ profile: personProfile(req.user.person_id), records: recordsFor({ personId: req.user.person_id, self: true })
    .concat(...all('SELECT id FROM businesses WHERE owner_person_id = ?', req.user.person_id)
      .map((b) => recordsFor({ businessId: b.id, self: true }))) });
});

// ---------- applications ----------
r.get('/applications', (req, res) => {
  const u = req.user; const where = []; const p = [];
  if (u.role === 'citizen') { where.push('ap.person_id = ?'); p.push(u.person_id); }
  else if (['front_office', 'back_office', 'ministry_leader'].includes(u.role)) {
    if (req.query.scope === 'referrals') { where.push('ap.id IN (SELECT application_id FROM referrals WHERE to_agency_id = ?)'); p.push(u.agency_id); }
    else { where.push('s.agency_id = ?'); p.push(u.agency_id); }
  } else if (!['admin', 'executive', 'security', 'finance'].includes(u.role)) throw forbidden();
  if (req.query.status) { const st = String(req.query.status).split(','); where.push(`ap.status IN (${st.map(() => '?').join(',')})`); p.push(...st); }
  if (req.query.mine === '1') { where.push('ap.assigned_to = ?'); p.push(u.id); }
  if (req.query.q) { where.push('(ap.reference LIKE ? OR pe.full_name LIKE ? OR pe.zan_id = ? OR b.name LIKE ?)'); const q = `%${req.query.q}%`; p.push(q, q, req.query.q, q); }
  const rows = all(`SELECT ap.id, ap.reference, ap.status, ap.channel, ap.created_at, ap.updated_at, ap.escalated, ap.assigned_to,
      s.name AS service, s.sla_days, a.name AS agency, pe.full_name AS applicant, b.name AS business,
      CAST(julianday('now') - julianday(ap.created_at) AS INTEGER) AS age_days,
      (SELECT status FROM payments WHERE application_id = ap.id) AS payment_status,
      (SELECT COUNT(*) FROM referrals WHERE application_id = ap.id AND status = 'open') AS open_referrals,
      u.full_name AS assignee
      FROM applications ap JOIN services s ON s.id = ap.service_id JOIN agencies a ON a.id = s.agency_id
      JOIN persons pe ON pe.id = ap.person_id LEFT JOIN businesses b ON b.id = ap.business_id LEFT JOIN users u ON u.id = ap.assigned_to
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ap.updated_at DESC LIMIT 500`, ...p);
  res.json(rows.map((x) => ({ ...x, status_label: wf.STATUS_LABEL[x.status] })));
});

r.post('/applications', requireRole('citizen', 'front_office'), upload.any(), (req, res) => {
  const discard = () => { for (const f of req.files || []) fs.rmSync(f.path, { force: true }); };
  let body;
  try { body = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body; } catch { discard(); throw bad('Invalid application data'); }
  let personId = req.user.person_id; let channel = 'online';
  if (req.user.role === 'front_office') {
    const p = one('SELECT id FROM persons WHERE zan_id = ?', String(body.zan_id || ''));
    if (!p) { discard(); throw bad('Look up the applicant by ZanID first'); }
    const svc = one('SELECT agency_id FROM services WHERE id = ?', body.service_id);
    if (!svc || svc.agency_id !== req.user.agency_id) { discard(); throw forbidden('Desk staff can only submit for their own agency’s services'); }
    personId = p.id; channel = 'desk';
  }
  let result;
  try {
    result = wf.submit(req, { serviceId: Number(body.service_id), personId, businessId: Number(body.business_id) || null, formData: body.form || {}, channel });
  } catch (e) {
    discard();
    throw e;
  }
  for (const f of req.files || []) storeFile(req, result.id, f.fieldname.replace(/^doc_/, ''), f);
  res.status(201).json(result);
});

function loadApp(req) {
  const app = wf.getApp(req.params.id);
  wf.assertView(req.user, app);
  return app;
}

r.get('/applications/:id', (req, res) => {
  const app = loadApp(req);
  if (req.user.role !== 'citizen') audit(req, 'application.view', 'application', app.id);
  res.json(wf.detail(req.user, app));
});

r.post('/applications/:id/documents', upload.single('file'), (req, res) => {
  const app = loadApp(req);
  if (!req.file) throw bad('Choose a file');
  const isApplicant = req.user.role === 'citizen' && req.user.person_id === app.person_id;
  const isDesk = req.user.role === 'front_office' && req.user.agency_id === app.service_agency_id;
  if (!isApplicant && !isDesk) { fs.rmSync(req.file.path, { force: true }); throw forbidden(); }
  if (!wf.OPEN_STATUSES.includes(app.status)) { fs.rmSync(req.file.path, { force: true }); throw bad('Application is closed'); }
  const code = String(req.body.doc_code || 'other');
  const id = storeFile(req, app.id, code, req.file);
  wf.event(app.id, 'document_uploaded', `Document uploaded: ${req.body.label || code}`, req);
  wf.afterUpload(req, wf.getApp(app.id), code);
  res.status(201).json({ id });
});

r.get('/documents/:id/download', (req, res) => {
  const d = one('SELECT * FROM documents WHERE id = ?', req.params.id);
  if (!d) throw notFound();
  const app = wf.getApp(d.application_id);
  wf.assertView(req.user, app);
  audit(req, 'document.download', 'document', d.id);
  res.setHeader('Content-Type', d.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${d.filename.replace(/[^\w.\- ]/g, '_')}"`);
  res.sendFile(path.join(UPLOAD_DIR, d.stored_name));
});

r.post('/documents/:id/review', requireRole('front_office', 'back_office'), (req, res) => {
  const d = one('SELECT * FROM documents WHERE id = ?', req.params.id);
  if (!d) throw notFound();
  const app = wf.getApp(d.application_id);
  if (app.service_agency_id !== req.user.agency_id) throw forbidden();
  const status = req.body.status;
  if (!['accepted', 'rejected'].includes(status)) throw bad('Invalid status');
  run('UPDATE documents SET status = ? WHERE id = ?', status, d.id);
  wf.event(app.id, 'document_reviewed', `Document "${d.filename}" ${status}${req.body.note ? ` – ${req.body.note}` : ''}`, req, { internal: status === 'accepted' });
  audit(req, 'document.review', 'document', d.id, { status });
  res.json({ ok: true });
});

const act = (fn) => (req, res) => { const app = loadApp(req); const out = fn(req, app); res.json(out || { ok: true }); };
r.post('/applications/:id/request-document', act((req, app) => wf.requestDocument(req, app, req.body)));
r.post('/applications/:id/route', act((req, app) => wf.route(req, app, req.body)));
r.post('/applications/:id/refer', act((req, app) => wf.refer(req, app, { to_agency_id: Number(req.body.to_agency_id), question: req.body.question })));
r.post('/applications/:id/approve', act((req, app) => wf.approve(req, app, req.body)));
r.post('/applications/:id/reject', act((req, app) => wf.reject(req, app, req.body)));
r.post('/applications/:id/issue', act((req, app) => wf.issue(req, app)));
r.post('/applications/:id/withdraw', act((req, app) => wf.withdraw(req, app)));
r.post('/applications/:id/assign', act((req, app) => {
  if (!['front_office', 'back_office', 'ministry_leader'].includes(req.user.role) || req.user.agency_id !== app.service_agency_id) throw forbidden();
  const u = one("SELECT id, full_name FROM users WHERE id = ? AND role = 'back_office' AND agency_id = ?", req.body.user_id, app.service_agency_id);
  if (!u) throw bad('Choose a back office officer of this agency');
  run('UPDATE applications SET assigned_to = ? WHERE id = ?', u.id, app.id);
  wf.event(app.id, 'assigned', `Assigned to ${u.full_name}`, req, { internal: true });
  audit(req, 'application.assign', 'application', app.id, { to: u.id });
}));
r.post('/applications/:id/escalate', act((req, app) => {
  if (!['ministry_leader', 'back_office'].includes(req.user.role) || req.user.agency_id !== app.service_agency_id) throw forbidden();
  if (!wf.OPEN_STATUSES.includes(app.status)) throw bad('Case is closed');
  if (!req.body.reason) throw bad('Give a reason');
  run('UPDATE applications SET escalated = 1 WHERE id = ?', app.id);
  wf.event(app.id, 'escalated', `Escalated for executive attention – ${req.body.reason}`, req, { internal: true });
  audit(req, 'application.escalate', 'application', app.id);
  require('../lib/sip').runRules();
}));

r.post('/applications/:id/note', act((req, app) => {
  if (!STAFF.includes(req.user.role)) throw forbidden();
  if (!req.body.text) throw bad('Write a note');
  wf.event(app.id, 'note', String(req.body.text).slice(0, 2000), req, { internal: true });
}));

// ---------- referrals ----------
r.get('/referrals', requireRole('front_office', 'back_office', 'ministry_leader', 'admin'), (req, res) => {
  const st = req.query.status || 'open';
  res.json(all(`SELECT rf.*, ap.reference, s.name AS service, fa.name AS from_agency, ta.name AS to_agency, pe.full_name AS applicant,
      CAST(julianday('now') - julianday(rf.created_at) AS INTEGER) AS age_days
      FROM referrals rf JOIN applications ap ON ap.id = rf.application_id JOIN services s ON s.id = ap.service_id
      JOIN agencies fa ON fa.id = rf.from_agency_id JOIN agencies ta ON ta.id = rf.to_agency_id JOIN persons pe ON pe.id = ap.person_id
      WHERE rf.to_agency_id = ? AND (? = 'all' OR rf.status = ?) ORDER BY rf.created_at`, req.user.agency_id || -1, st, st));
});
r.post('/referrals/:id/answer', requireRole('front_office', 'back_office', 'admin'), (req, res) => {
  wf.answerReferral(req, Number(req.params.id), req.body);
  res.json({ ok: true });
});

// ---------- staff directory (for assignment) ----------
r.get('/staff', requireRole('front_office', 'back_office', 'ministry_leader'), (req, res) => {
  res.json(all("SELECT id, full_name, role FROM users WHERE agency_id = ? AND active = 1 AND role IN ('front_office','back_office') ORDER BY full_name", req.user.agency_id));
});

// ---------- issued documents ----------
r.get('/applications/:id/certificate', async (req, res) => {
  const app = loadApp(req);
  const d = one('SELECT * FROM issued_documents WHERE application_id = ?', app.id);
  if (!d) throw notFound('Not issued yet');
  audit(req, 'certificate.view', 'issued_document', d.id);
  res.type('html').send(await require('../lib/render').certificate(d, `${req.protocol}://${req.get('host')}`));
});

// ---------- notifications ----------
r.get('/notifications', (req, res) => {
  const rows = req.user.role === 'citizen'
    ? all('SELECT * FROM notifications WHERE person_id = ? ORDER BY id DESC LIMIT 50', req.user.person_id)
    : all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', req.user.id);
  res.json(rows);
});
r.post('/notifications/read', (req, res) => {
  if (req.user.role === 'citizen') run('UPDATE notifications SET read = 1 WHERE person_id = ?', req.user.person_id);
  else run('UPDATE notifications SET read = 1 WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
});

module.exports = r;
