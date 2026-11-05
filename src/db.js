'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.IGP_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.IGP_DB || path.join(DATA_DIR, 'igp.sqlite');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS agencies (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ministry', integrated INTEGER NOT NULL DEFAULT 0
);

-- Civil registry (source of verified identity)
CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY, zan_id TEXT UNIQUE NOT NULL, full_name TEXT NOT NULL,
  dob TEXT, sex TEXT, phone TEXT, address TEXT, district TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY, brn TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  owner_person_id INTEGER NOT NULL REFERENCES persons(id), tin TEXT, sector TEXT,
  address TEXT, phone TEXT, registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Verified records issued by agencies; reused across government
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY, record_type TEXT NOT NULL,
  person_id INTEGER REFERENCES persons(id), business_id INTEGER REFERENCES businesses(id),
  issuing_agency_id INTEGER NOT NULL REFERENCES agencies(id),
  number TEXT, data TEXT NOT NULL DEFAULT '{}', valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'valid', issued_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_records_person ON records(person_id);
CREATE INDEX IF NOT EXISTS idx_records_business ON records(business_id);

CREATE TABLE IF NOT EXISTS record_types (code TEXT PRIMARY KEY, name TEXT NOT NULL, owner_agency_id INTEGER REFERENCES agencies(id));
CREATE TABLE IF NOT EXISTS record_access_grants (
  agency_id INTEGER NOT NULL REFERENCES agencies(id), record_type TEXT NOT NULL REFERENCES record_types(code),
  PRIMARY KEY (agency_id, record_type)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL, role TEXT NOT NULL, agency_id INTEGER REFERENCES agencies(id),
  person_id INTEGER REFERENCES persons(id), phone TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT,
  agency_id INTEGER NOT NULL REFERENCES agencies(id), fee INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL DEFAULT 'person',                 -- person | business
  form_schema TEXT NOT NULL DEFAULT '[]',                 -- [{name,label,type,required,options,prefill}]
  required_docs TEXT NOT NULL DEFAULT '[]',               -- [{code,label,record_type?}]
  referral_agencies TEXT NOT NULL DEFAULT '[]',           -- [agency codes]
  sla_days INTEGER NOT NULL DEFAULT 14, output_name TEXT, output_validity_days INTEGER DEFAULT 365,
  origin TEXT NOT NULL DEFAULT 'digitized',               -- digitized (was manual) | integrated (was online)
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY, reference TEXT UNIQUE NOT NULL,
  service_id INTEGER NOT NULL REFERENCES services(id),
  person_id INTEGER NOT NULL REFERENCES persons(id), business_id INTEGER REFERENCES businesses(id),
  submitted_by INTEGER REFERENCES users(id), channel TEXT NOT NULL DEFAULT 'online',
  form_data TEXT NOT NULL DEFAULT '{}', reused_records TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'submitted',
  -- submitted | awaiting_applicant | in_review | awaiting_payment | approved | issued | rejected | withdrawn
  assigned_to INTEGER REFERENCES users(id), escalated INTEGER NOT NULL DEFAULT 0,
  decision_note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_person ON applications(person_id);
CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status);

CREATE TABLE IF NOT EXISTS application_events (
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id),
  kind TEXT NOT NULL, message TEXT NOT NULL, actor_id INTEGER REFERENCES users(id),
  agency_id INTEGER REFERENCES agencies(id), visible_to_applicant INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id),
  doc_code TEXT NOT NULL, filename TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT,
  size INTEGER, sha256 TEXT NOT NULL, uploaded_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_requests (
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id),
  doc_code TEXT NOT NULL, label TEXT NOT NULL, message TEXT, requested_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')), fulfilled_at TEXT
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id),
  from_agency_id INTEGER NOT NULL REFERENCES agencies(id), to_agency_id INTEGER NOT NULL REFERENCES agencies(id),
  question TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',    -- open | answered
  outcome TEXT, note TEXT, created_by INTEGER REFERENCES users(id), responded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), responded_at TEXT
);

CREATE TABLE IF NOT EXISTS payment_providers (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'sandbox',
  callback_secret TEXT NOT NULL, api_base TEXT, enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id),
  control_number TEXT UNIQUE NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'TZS',
  status TEXT NOT NULL DEFAULT 'unpaid',  -- unpaid | pending | paid | failed
  provider TEXT REFERENCES payment_providers(code), msisdn TEXT, provider_ref TEXT, receipt_no TEXT,
  paid_amount INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), initiated_at TEXT, paid_at TEXT,
  reconciled INTEGER NOT NULL DEFAULT 0, reconciled_by INTEGER REFERENCES users(id), reconciled_at TEXT
);

CREATE TABLE IF NOT EXISTS payment_callbacks (
  id INTEGER PRIMARY KEY, provider TEXT, body TEXT, signature_ok INTEGER, outcome TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sandbox mobile network: pending handset prompts (stands in for a real STK/USSD push)
CREATE TABLE IF NOT EXISTS sandbox_prompts (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, msisdn TEXT NOT NULL, amount INTEGER NOT NULL,
  control_number TEXT NOT NULL, provider_ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS statement_lines (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, provider_ref TEXT, control_number TEXT,
  amount INTEGER, txn_date TEXT, match_status TEXT, payment_id INTEGER REFERENCES payments(id),
  imported_by INTEGER REFERENCES users(id), imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS issued_documents (
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id),
  number TEXT UNIQUE NOT NULL, title TEXT NOT NULL, verification_code TEXT UNIQUE NOT NULL,
  data TEXT NOT NULL, issued_by INTEGER REFERENCES users(id),
  issued_at TEXT NOT NULL DEFAULT (datetime('now')), valid_until TEXT, revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, person_id INTEGER REFERENCES persons(id), user_id INTEGER REFERENCES users(id),
  application_id INTEGER REFERENCES applications(id), message TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sms_outbox (
  id INTEGER PRIMARY KEY, msisdn TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY, agency_id INTEGER NOT NULL REFERENCES agencies(id), label TEXT NOT NULL,
  key_prefix TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, rule TEXT NOT NULL, severity TEXT NOT NULL, agency_id INTEGER REFERENCES agencies(id),
  entity TEXT, entity_id INTEGER, fingerprint TEXT UNIQUE NOT NULL, title TEXT NOT NULL, detail TEXT,
  audience TEXT NOT NULL DEFAULT 'ministry',  -- ministry | security | executive
  status TEXT NOT NULL DEFAULT 'open', ack_by INTEGER REFERENCES users(id), ack_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sip_snapshots (
  day TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')), user_id INTEGER, username TEXT,
  role TEXT, agency_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT,
  purpose TEXT, ip TEXT, prev_hash TEXT, hash TEXT
);
`;
db.exec(SCHEMA);

// migrations for databases created by earlier versions
{
  const cols = db.prepare('PRAGMA table_info(sms_outbox)').all().map((c) => c.name);
  for (const [name, def] of [['attempts', 'INTEGER NOT NULL DEFAULT 0'], ['next_attempt_at', 'TEXT'], ['gateway', 'TEXT'], ['gateway_ref', 'TEXT'],
    ['sent_to', 'TEXT'], ['sent_at', 'TEXT'], ['last_error', 'TEXT']]) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE sms_outbox ADD COLUMN ${name} ${def}`);
  }
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function getSetting(key, dflt = null) {
  const r = one('SELECT value FROM settings WHERE key = ?', key);
  return r ? JSON.parse(r.value) : dflt;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}

module.exports = { db, tx, one, all, run, getSetting, setSetting, DATA_DIR, DB_FILE };
