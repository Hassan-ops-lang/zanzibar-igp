'use strict';
const crypto = require('node:crypto');
const { one, all, run } = require('../db');

// ---------- errors ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const forbidden = (m = 'You do not have access to this') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);

// ---------- passwords ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');

// ---------- roles ----------
const ROLES = {
  citizen: 'Applicant',
  front_office: 'Front office officer',
  back_office: 'Back office officer',
  finance: 'Finance officer',
  ministry_leader: 'Ministry leader',
  security: 'Security services analyst',
  executive: 'Executive',
  admin: 'System administrator',
};
const STAFF = ['front_office', 'back_office', 'finance', 'ministry_leader', 'security', 'executive', 'admin'];
const SIP_ROLES = ['ministry_leader', 'security', 'executive'];

// ---------- audit (hash-chained, tamper-evident) ----------
function audit(req, action, entity = null, entityId = null, detail = null, purpose = null) {
  const u = req && req.user;
  const prev = one('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const ts = new Date().toISOString();
  const row = {
    ts, user_id: u && u.id != null ? Number(u.id) : null, username: u ? (u.username || null) : (req && req.apiAgency ? `api:${req.apiAgency.code}` : 'system'),
    role: u ? u.role : (req && req.apiAgency ? 'agency_api' : 'system'),
    agency_id: u ? (u.agency_id ?? null) : (req && req.apiAgency ? req.apiAgency.id : null),
    action, entity, entity_id: entityId == null ? null : String(entityId),
    detail: detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
    purpose, ip: req && req.ip ? req.ip : null, prev_hash: prev ? prev.hash : 'GENESIS',
  };
  row.hash = sha256(JSON.stringify(row));
  run(`INSERT INTO audit_log(ts,user_id,username,role,agency_id,action,entity,entity_id,detail,purpose,ip,prev_hash,hash)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.ts, row.user_id, row.username, row.role, row.agency_id,
  row.action, row.entity, row.entity_id, row.detail, row.purpose, row.ip, row.prev_hash, row.hash);
}
function verifyAuditChain() {
  const rows = all('SELECT * FROM audit_log ORDER BY id');
  let prev = 'GENESIS';
  for (const r of rows) {
    const { id, hash, ...rest } = r;
    if (rest.prev_hash !== prev) return { ok: false, brokenAt: id, total: rows.length };
    const calc = sha256(JSON.stringify({ ts: rest.ts, user_id: rest.user_id, username: rest.username, role: rest.role,
      agency_id: rest.agency_id, action: rest.action, entity: rest.entity, entity_id: rest.entity_id, detail: rest.detail,
      purpose: rest.purpose, ip: rest.ip, prev_hash: rest.prev_hash }));
    if (calc !== hash) return { ok: false, brokenAt: id, total: rows.length };
    prev = hash;
  }
  return { ok: true, total: rows.length };
}

// ---------- notifications ----------
function notifyPerson(personId, applicationId, message) {
  run('INSERT INTO notifications(person_id, application_id, message) VALUES(?,?,?)', personId, applicationId, message);
  const p = one('SELECT phone FROM persons WHERE id = ?', personId);
  if (p && p.phone) { run('INSERT INTO sms_outbox(msisdn, message) VALUES(?,?)', p.phone, message); require('./sms').kick(); }
}

// ---------- references ----------
function newReference(prefix = 'ZNZ') {
  const y = new Date().getFullYear();
  for (;;) {
    const ref = `${prefix}-${y}-${crypto.randomInt(100000, 999999)}`;
    if (!one('SELECT 1 FROM applications WHERE reference = ?', ref)) return ref;
  }
}
function newControlNumber() {
  for (;;) {
    const cn = '99' + String(crypto.randomInt(0, 1e10)).padStart(10, '0');
    if (!one('SELECT 1 FROM payments WHERE control_number = ?', cn)) return cn;
  }
}

const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

module.exports = {
  HttpError, bad, forbidden, notFound, hashPassword, verifyPassword, sha256, randomToken,
  ROLES, STAFF, SIP_ROLES, audit, verifyAuditChain, notifyPerson, newReference, newControlNumber, parse, nowSql,
};
