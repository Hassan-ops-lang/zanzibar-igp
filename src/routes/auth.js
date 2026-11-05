'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { one, run, getSetting } = require('../db');
const { bad, HttpError, hashPassword, verifyPassword, audit, ROLES } = require('../lib/core');
const { createSession, destroySession, requireAuth, SESSION_HOURS } = require('../lib/auth');
const { personProfile } = require('../lib/records');
const { sipEnabled } = require('../lib/sip');

const r = express.Router();
const attempts = new Map(); // username -> { n, until }
const otps = new Map(); // zan_id -> { otp, exp, tries }

function cookie(res, token) {
  const secure = process.env.IGP_SECURE_COOKIES === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `igp_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure}`);
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || !/\d/.test(pw) || !/[A-Za-z]/.test(pw)) {
    throw bad('Password must be at least 8 characters and contain letters and numbers');
  }
}

r.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const a = attempts.get(username);
  if (a && a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const u = one('SELECT * FROM users WHERE username = ?', username);
  if (!u || !u.active || !verifyPassword(String(req.body.password || ''), u.password_hash)) {
    const n = (a ? a.n : 0) + 1;
    attempts.set(username, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
    audit(req, 'auth.login_failed', 'user', username);
    throw new HttpError(401, 'Incorrect username or password');
  }
  attempts.delete(username);
  const token = createSession(u.id);
  cookie(res, token);
  req.user = u;
  audit(req, 'auth.login', 'user', u.id);
  res.json({ ok: true, token });
});

r.post('/logout', (req, res) => {
  destroySession(req.token);
  res.setHeader('Set-Cookie', 'igp_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
  res.json({ ok: true });
});

r.get('/me', (req, res) => {
  const phases = getSetting('phases', {});
  if (!req.user) return res.json({ user: null, phases, sip_enabled: sipEnabled() });
  const out = { ...req.user, role_label: ROLES[req.user.role] };
  if (req.user.person_id) out.person = personProfile(req.user.person_id);
  res.json({ user: out, phases, sip_enabled: sipEnabled() });
});

// Citizen self-registration: identity is checked against the civil registry and confirmed by SMS code
r.post('/register/start', (req, res) => {
  const zan = String(req.body.zan_id || '').trim();
  const p = one('SELECT * FROM persons WHERE zan_id = ?', zan);
  if (!p || p.dob !== String(req.body.dob || '')) throw bad('ZanID and date of birth do not match the civil registry');
  if (one('SELECT 1 FROM users WHERE person_id = ?', p.id)) throw bad('An account already exists for this ZanID. Sign in instead.');
  if (!p.phone) throw bad('No phone number on record. Please register at a government service desk.');
  const otp = String(crypto.randomInt(100000, 999999));
  otps.set(zan, { otp, exp: Date.now() + 10 * 60e3, tries: 0 });
  run('INSERT INTO sms_outbox(msisdn, message) VALUES(?,?)', p.phone, `Your Zanzibar e-Government verification code is ${otp}. It expires in 10 minutes.`);
  audit(req, 'auth.register_start', 'person', p.id);
  const out = { ok: true, phone_hint: `•••• ${p.phone.slice(-3)}`, full_name: p.full_name };
  if ((process.env.IGP_SMS_MODE || 'sandbox') === 'sandbox') out.sandbox_code = otp; // shown only while SMS gateway is in sandbox mode
  res.json(out);
});

r.post('/register/complete', (req, res) => {
  const zan = String(req.body.zan_id || '').trim();
  const o = otps.get(zan);
  if (!o || o.exp < Date.now()) throw bad('Code expired. Start again.');
  if (++o.tries > 5) { otps.delete(zan); throw bad('Too many attempts. Start again.'); }
  if (String(req.body.code || '').trim() !== o.otp) throw bad('Incorrect code');
  const p = one('SELECT * FROM persons WHERE zan_id = ?', zan);
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw bad('Username: 3–32 letters, numbers, dot, dash or underscore');
  if (one('SELECT 1 FROM users WHERE username = ?', username)) throw bad('That username is taken');
  checkPassword(req.body.password);
  const info = run("INSERT INTO users(username, password_hash, full_name, role, person_id, phone) VALUES(?,?,?, 'citizen', ?, ?)",
    username, hashPassword(req.body.password), p.full_name, p.id, p.phone);
  otps.delete(zan);
  const token = createSession(Number(info.lastInsertRowid));
  cookie(res, token);
  req.user = { id: Number(info.lastInsertRowid), username, role: 'citizen' };
  audit(req, 'auth.register_complete', 'user', info.lastInsertRowid);
  res.json({ ok: true });
});

r.post('/password', requireAuth, (req, res) => {
  const u = one('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(req.body.current || ''), u.password_hash)) throw bad('Current password is incorrect');
  checkPassword(req.body.password);
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.password), u.id);
  audit(req, 'auth.password_change', 'user', u.id);
  res.json({ ok: true });
});

module.exports = r;
module.exports.checkPassword = checkPassword;
