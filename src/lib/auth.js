'use strict';
const { one, run } = require('../db');
const { sha256, randomToken, forbidden, HttpError } = require('./core');

const SESSION_HOURS = 12;

function createSession(userId) {
  const token = randomToken();
  const exp = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
  run('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)', sha256(token), userId, exp);
  return token;
}
function destroySession(token) { if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token)); }

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|;\s*)igp_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function loadUser(req, _res, next) {
  const token = readToken(req);
  req.token = token;
  if (!token) return next();
  const s = one(`SELECT s.expires_at, u.id, u.username, u.full_name, u.role, u.agency_id, u.person_id, u.phone, u.active,
                 a.code AS agency_code, a.name AS agency_name
                 FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN agencies a ON a.id = u.agency_id
                 WHERE s.token_hash = ?`, sha256(token));
  if (s && s.active && s.expires_at > new Date().toISOString()) {
    const { expires_at, ...user } = s;
    req.user = user;
  }
  next();
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  next();
}
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in'));
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

// Inter-agency API key auth
function requireApiKey(req, _res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return next(new HttpError(401, 'X-API-Key header required'));
  const k = one(`SELECT k.id, a.id AS agency_id, a.code, a.name FROM api_keys k JOIN agencies a ON a.id = k.agency_id
                 WHERE k.key_hash = ? AND k.active = 1`, sha256(String(key)));
  if (!k) return next(new HttpError(401, 'Invalid API key'));
  run("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?", k.id);
  req.apiAgency = { id: k.agency_id, code: k.code, name: k.name };
  next();
}

module.exports = { createSession, destroySession, loadUser, requireAuth, requireRole, requireApiKey, SESSION_HOURS };
