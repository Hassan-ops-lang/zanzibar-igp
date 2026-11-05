'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { one, all, run, tx, getSetting, setSetting } = require('../db');
const { bad, notFound, hashPassword, audit, verifyAuditChain, sha256, parse, ROLES } = require('../lib/core');
const { requireRole } = require('../lib/auth');
const { checkPassword } = require('./auth');

const r = express.Router();
r.use(requireRole('admin'));

// ---------- rollout phases ----------
r.get('/phases', (_req, res) => res.json(getSetting('phases', {})));
r.put('/phases', (req, res) => {
  const cur = getSetting('phases', {});
  for (const k of Object.keys(cur)) if (req.body[k] !== undefined) cur[k].live = !!req.body[k];
  setSetting('phases', cur);
  audit(req, 'admin.phases', 'settings', 'phases', cur);
  res.json(cur);
});

// ---------- agencies ----------
r.get('/agencies', (_req, res) => res.json(all(`SELECT a.*, (SELECT COUNT(*) FROM services s WHERE s.agency_id = a.id) AS services,
  (SELECT COUNT(*) FROM users u WHERE u.agency_id = a.id) AS staff FROM agencies a ORDER BY a.name`)));
r.post('/agencies', (req, res) => {
  const { code, name, kind } = req.body;
  if (!/^[A-Z0-9_]{2,12}$/.test(code || '')) throw bad('Code: 2–12 capital letters/digits');
  if (!name) throw bad('Name required');
  const i = run('INSERT INTO agencies(code, name, kind, integrated) VALUES(?,?,?,?)', code, name, kind || 'agency', req.body.integrated ? 1 : 0);
  audit(req, 'admin.agency_create', 'agency', i.lastInsertRowid, { code });
  res.status(201).json({ id: Number(i.lastInsertRowid) });
});
r.put('/agencies/:id', (req, res) => {
  const a = one('SELECT * FROM agencies WHERE id = ?', req.params.id);
  if (!a) throw notFound();
  run('UPDATE agencies SET name = ?, kind = ?, integrated = ? WHERE id = ?', req.body.name || a.name, req.body.kind || a.kind,
    req.body.integrated === undefined ? a.integrated : (req.body.integrated ? 1 : 0), a.id);
  audit(req, 'admin.agency_update', 'agency', a.id, req.body);
  res.json({ ok: true });
});

// ---------- services (digitizing a manual service = defining its form, documents and routing) ----------
function validateService(b) {
  if (!/^[A-Z0-9_]{2,16}$/.test(b.code || '')) throw bad('Code: 2–16 capital letters/digits/underscore');
  if (!b.name) throw bad('Name required');
  if (!one('SELECT 1 FROM agencies WHERE id = ?', b.agency_id)) throw bad('Choose the responsible agency');
  const form = Array.isArray(b.form_schema) ? b.form_schema : parse(b.form_schema, null);
  if (!Array.isArray(form)) throw bad('Form fields must be a list');
  for (const f of form) {
    if (!/^[a-z][a-z0-9_]*$/.test(f.name || '')) throw bad(`Field name "${f.name}" must be lower_snake_case`);
    if (!['text', 'number', 'date', 'select', 'textarea'].includes(f.type)) throw bad(`Field ${f.name}: unknown type ${f.type}`);
    if (f.type === 'select' && (!Array.isArray(f.options) || !f.options.length)) throw bad(`Field ${f.name}: add options`);
  }
  const docs = Array.isArray(b.required_docs) ? b.required_docs : parse(b.required_docs, null);
  if (!Array.isArray(docs)) throw bad('Required documents must be a list');
  for (const d of docs) {
    if (!d.code || !d.label) throw bad('Each document needs a code and label');
    if (d.record_type && !one('SELECT 1 FROM record_types WHERE code = ?', d.record_type)) throw bad(`Unknown record type ${d.record_type}`);
  }
  const refs = Array.isArray(b.referral_agencies) ? b.referral_agencies : [];
  for (const c of refs) if (!one('SELECT 1 FROM agencies WHERE code = ?', c)) throw bad(`Unknown agency ${c}`);
  return { form, docs, refs };
}
r.get('/services', (_req, res) => res.json(all('SELECT s.*, a.name AS agency FROM services s JOIN agencies a ON a.id = s.agency_id ORDER BY a.name, s.name')
  .map((s) => ({ ...s, form_schema: parse(s.form_schema, []), required_docs: parse(s.required_docs, []), referral_agencies: parse(s.referral_agencies, []) }))));
r.post('/services', (req, res) => {
  const b = req.body; const { form, docs, refs } = validateService(b);
  const i = run(`INSERT INTO services(code, name, description, agency_id, fee, subject, form_schema, required_docs, referral_agencies, sla_days, output_name, output_validity_days, origin, active)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, b.code, b.name, b.description || '', b.agency_id, Number(b.fee) || 0, b.subject === 'business' ? 'business' : 'person',
  JSON.stringify(form), JSON.stringify(docs), JSON.stringify(refs), Number(b.sla_days) || 14, b.output_name || b.name, Number(b.output_validity_days) || null,
  b.origin === 'integrated' ? 'integrated' : 'digitized', b.active === false ? 0 : 1);
  audit(req, 'admin.service_create', 'service', i.lastInsertRowid, { code: b.code });
  res.status(201).json({ id: Number(i.lastInsertRowid) });
});
r.put('/services/:id', (req, res) => {
  const s = one('SELECT * FROM services WHERE id = ?', req.params.id);
  if (!s) throw notFound();
  const b = { ...s, ...req.body, code: s.code };
  const { form, docs, refs } = validateService({ ...b, referral_agencies: req.body.referral_agencies || parse(s.referral_agencies, []) });
  run(`UPDATE services SET name=?, description=?, agency_id=?, fee=?, subject=?, form_schema=?, required_docs=?, referral_agencies=?, sla_days=?,
    output_name=?, output_validity_days=?, origin=?, active=? WHERE id = ?`, b.name, b.description || '', b.agency_id, Number(b.fee) || 0,
  b.subject === 'business' ? 'business' : 'person', JSON.stringify(form), JSON.stringify(docs), JSON.stringify(refs), Number(b.sla_days) || 14,
  b.output_name, Number(b.output_validity_days) || null, b.origin === 'integrated' ? 'integrated' : 'digitized', b.active ? 1 : 0, s.id);
  audit(req, 'admin.service_update', 'service', s.id);
  res.json({ ok: true });
});

// ---------- verified records: types and access grants ----------
r.get('/record-types', (_req, res) => {
  const types = all('SELECT t.*, a.name AS owner FROM record_types t LEFT JOIN agencies a ON a.id = t.owner_agency_id ORDER BY t.name');
  const grants = all('SELECT * FROM record_access_grants');
  res.json(types.map((t) => ({ ...t, granted_to: grants.filter((g) => g.record_type === t.code).map((g) => g.agency_id) })));
});
r.post('/record-types', (req, res) => {
  if (!/^[a-z0-9_]{2,32}$/.test(req.body.code || '') || !req.body.name) throw bad('Code (lower_snake) and name required');
  run('INSERT INTO record_types(code, name, owner_agency_id) VALUES(?,?,?)', req.body.code, req.body.name, req.body.owner_agency_id || null);
  audit(req, 'admin.record_type_create', 'record_type', req.body.code);
  res.status(201).json({ ok: true });
});
r.put('/record-types/:code/grants', (req, res) => {
  const ids = (req.body.agency_ids || []).map(Number);
  tx(() => {
    run('DELETE FROM record_access_grants WHERE record_type = ?', req.params.code);
    for (const id of ids) run('INSERT INTO record_access_grants(agency_id, record_type) VALUES(?,?)', id, req.params.code);
  });
  audit(req, 'admin.record_grants', 'record_type', req.params.code, { agency_ids: ids });
  res.json({ ok: true });
});

// ---------- civil registry maintenance (normally fed by the registry agency's system via the API) ----------
r.get('/persons', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  res.json(all('SELECT * FROM persons WHERE full_name LIKE ? OR zan_id LIKE ? ORDER BY full_name LIMIT 100', q, q));
});
r.post('/persons', (req, res) => {
  const b = req.body;
  if (!b.zan_id || !b.full_name || !/^\d{4}-\d{2}-\d{2}$/.test(b.dob || '')) throw bad('ZanID, full name and date of birth (YYYY-MM-DD) required');
  const phone = b.phone ? require('../lib/payments').normaliseMsisdn(b.phone) : null;
  const i = run('INSERT INTO persons(zan_id, full_name, dob, sex, phone, address, district) VALUES(?,?,?,?,?,?,?)',
    b.zan_id, b.full_name, b.dob, b.sex || null, phone, b.address || null, b.district || null);
  audit(req, 'admin.person_create', 'person', i.lastInsertRowid);
  res.status(201).json({ id: Number(i.lastInsertRowid) });
});

// ---------- users ----------
r.get('/users', (_req, res) => res.json(all(`SELECT u.id, u.username, u.full_name, u.role, u.agency_id, u.active, u.phone, u.created_at, a.name AS agency
  FROM users u LEFT JOIN agencies a ON a.id = u.agency_id ORDER BY u.role = 'citizen', a.name, u.full_name`)));
r.post('/users', (req, res) => {
  const b = req.body;
  if (!ROLES[b.role] || b.role === 'citizen') throw bad('Choose a staff role');
  if (['front_office', 'back_office', 'ministry_leader'].includes(b.role) && !one('SELECT 1 FROM agencies WHERE id = ?', b.agency_id)) throw bad('This role needs an agency');
  const username = String(b.username || '').toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw bad('Invalid username');
  if (!b.full_name) throw bad('Full name required');
  checkPassword(b.password);
  const i = run('INSERT INTO users(username, password_hash, full_name, role, agency_id, phone) VALUES(?,?,?,?,?,?)',
    username, hashPassword(b.password), b.full_name, b.role, b.agency_id || null, b.phone || null);
  audit(req, 'admin.user_create', 'user', i.lastInsertRowid, { role: b.role });
  res.status(201).json({ id: Number(i.lastInsertRowid) });
});
r.put('/users/:id', (req, res) => {
  const u = one('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) throw notFound();
  if (req.body.password) { checkPassword(req.body.password); run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.password), u.id); run('DELETE FROM sessions WHERE user_id = ?', u.id); }
  if (req.body.active !== undefined) { run('UPDATE users SET active = ? WHERE id = ?', req.body.active ? 1 : 0, u.id); if (!req.body.active) run('DELETE FROM sessions WHERE user_id = ?', u.id); }
  if (req.body.role && ROLES[req.body.role] && u.role !== 'citizen' && req.body.role !== 'citizen') run('UPDATE users SET role = ?, agency_id = ? WHERE id = ?', req.body.role, req.body.agency_id || null, u.id);
  audit(req, 'admin.user_update', 'user', u.id, { ...req.body, password: req.body.password ? '***' : undefined });
  res.json({ ok: true });
});

// ---------- inter-agency API keys ----------
r.get('/api-keys', (_req, res) => res.json(all('SELECT k.id, k.label, k.key_prefix, k.active, k.created_at, k.last_used_at, a.name AS agency, a.code FROM api_keys k JOIN agencies a ON a.id = k.agency_id ORDER BY k.id DESC')));
r.post('/api-keys', (req, res) => {
  const a = one('SELECT * FROM agencies WHERE id = ?', req.body.agency_id);
  if (!a) throw bad('Choose an agency');
  const key = `igp_${a.code.toLowerCase()}_${crypto.randomBytes(24).toString('base64url')}`;
  run('INSERT INTO api_keys(agency_id, label, key_prefix, key_hash) VALUES(?,?,?,?)', a.id, req.body.label || `${a.code} system`, key.slice(0, 14), sha256(key));
  audit(req, 'admin.api_key_create', 'agency', a.id);
  res.status(201).json({ key, note: 'Copy this key now. It will not be shown again.' });
});
r.delete('/api-keys/:id', (req, res) => {
  run('UPDATE api_keys SET active = 0 WHERE id = ?', req.params.id);
  audit(req, 'admin.api_key_revoke', 'api_key', req.params.id);
  res.json({ ok: true });
});

// ---------- payment providers ----------
r.get('/providers', (_req, res) => res.json(all('SELECT code, name, mode, api_base, enabled, substr(callback_secret,1,6) || \'…\' AS secret_hint FROM payment_providers')));
r.put('/providers/:code', (req, res) => {
  const p = one('SELECT * FROM payment_providers WHERE code = ?', req.params.code);
  if (!p) throw notFound();
  const mode = req.body.mode || p.mode;
  if (!['sandbox', 'live'].includes(mode)) throw bad('Mode must be sandbox or live');
  const apiBase = req.body.api_base !== undefined ? req.body.api_base : p.api_base;
  if (mode === 'live' && !/^https:\/\//.test(apiBase || '')) throw bad('Live mode needs the provider HTTPS API base URL');
  const secret = req.body.callback_secret || p.callback_secret;
  run('UPDATE payment_providers SET name = ?, mode = ?, api_base = ?, enabled = ?, callback_secret = ? WHERE code = ?',
    req.body.name || p.name, mode, apiBase || null, req.body.enabled === undefined ? p.enabled : (req.body.enabled ? 1 : 0), secret, p.code);
  audit(req, 'admin.provider_update', 'provider', p.code, { mode, enabled: req.body.enabled });
  res.json({ ok: true });
});

// ---------- audit ----------
r.get('/audit', (req, res) => {
  const w = []; const p = [];
  if (req.query.action) { w.push('action LIKE ?'); p.push(`%${req.query.action}%`); }
  if (req.query.user) { w.push('username LIKE ?'); p.push(`%${req.query.user}%`); }
  res.json(all(`SELECT * FROM audit_log ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`, ...p));
});
r.get('/audit/verify', (_req, res) => res.json(verifyAuditChain()));
r.get('/sms', (_req, res) => res.json(all('SELECT * FROM sms_outbox ORDER BY id DESC LIMIT 200')));
r.get('/callbacks', (_req, res) => res.json(all('SELECT * FROM payment_callbacks ORDER BY id DESC LIMIT 100')));

module.exports = r;
