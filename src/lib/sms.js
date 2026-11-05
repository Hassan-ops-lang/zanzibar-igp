'use strict';
/*
 * SMS delivery. Messages are always written to sms_outbox first (by notifyPerson / sign-up), then a background
 * worker delivers them through the gateway chosen in Admin → SMS:
 *
 *   outbox   – nothing leaves the system; messages stay in the outbox (default, and sign-up codes are shown on screen)
 *   android  – an Android phone running the free "SMS Gateway for Android" app (https://sms-gate.app) sends the texts
 *              from its own SIM. Works with the app's Local server (http://<phone-ip>:8080) or Cloud server
 *              (https://api.sms-gate.app/3rdparty/v1). Username/password are shown in the app.
 *   beem     – Beem Africa bulk SMS (paid, approved sender name such as ZANGOV).
 *
 * Demo safety: when "redirect_to" is set, every message is sent to that number instead of the real recipient
 * (the sample data's phone numbers are made up and may belong to real people). Only messages created after the
 * gateway was switched on are ever sent, so old outbox contents are never blasted out.
 */
const { one, all, run, getSetting, setSetting } = require('../db');
const { bad } = require('./core');

const MODES = ['outbox', 'android', 'beem'];
const DEFAULTS = {
  mode: process.env.IGP_SMS_MODE === 'sandbox' || !process.env.IGP_SMS_MODE ? 'outbox' : process.env.IGP_SMS_MODE,
  enabled_at: null,
  redirect_to: process.env.IGP_SMS_REDIRECT || '', // demo phone(s) that receive every text – entered in Admin → SMS → Settings
  android: { url: 'https://api.sms-gate.app/3rdparty/v1', username: '', password: '' },
  beem: { api_key: '', secret_key: '', sender: 'INFO' },
};
const MAX_ATTEMPTS = 3;

// Tanzanian numbers may be written locally (0777 123 456); any other country needs its + code (e.g. +254 700 000 000)
function normalise(m) {
  const t = String(m || '').trim();
  let s = t.replace(/[^\d]/g, '');
  if (t.startsWith('+') || s.startsWith('00')) {
    s = s.replace(/^00/, '');
    if (s.startsWith('255') ? /^255[67]\d{8}$/.test(s) : /^[1-9]\d{7,14}$/.test(s)) return s;
  } else {
    if (s.startsWith('0')) s = '255' + s.slice(1);
    if (/^255[67]\d{8}$/.test(s)) return s;
  }
  throw bad(`"${t}" is not a valid mobile number – write e.g. 0777 123 456, or +254 700 000 000 for other countries`);
}

function config() {
  const c = getSetting('sms', null) || {};
  return { ...DEFAULTS, ...c, android: { ...DEFAULTS.android, ...(c.android || {}) }, beem: { ...DEFAULTS.beem, ...(c.beem || {}) } };
}
const mask = (s) => (s ? `${String(s).slice(0, 3)}••••` : '');
function publicConfig() {
  const c = config();
  return { mode: c.mode, enabled_at: c.enabled_at, redirect_to: c.redirect_to,
    android: { url: c.android.url, username: c.android.username, password_set: !!c.android.password, password_hint: mask(c.android.password) },
    beem: { sender: c.beem.sender, api_key_hint: mask(c.beem.api_key), secret_set: !!c.beem.secret_key } };
}

function updateConfig(b) {
  const c = config();
  if (b.mode !== undefined) {
    if (!MODES.includes(b.mode)) throw bad('Unknown SMS mode');
    if (b.mode !== c.mode) c.enabled_at = b.mode === 'outbox' ? null : new Date().toISOString().replace('T', ' ').slice(0, 19);
    c.mode = b.mode;
  }
  if (b.redirect_to !== undefined) {
    c.redirect_to = String(b.redirect_to || '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).map(normalise).join(',');
  }
  if (b.android) {
    if (b.android.url !== undefined) {
      const u = String(b.android.url).trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\/[^\s]+$/.test(u)) throw bad('Gateway address must start with http:// or https://');
      c.android.url = u;
    }
    if (b.android.username !== undefined) c.android.username = String(b.android.username).trim();
    if (b.android.password) c.android.password = String(b.android.password);
  }
  if (b.beem) {
    if (b.beem.api_key) c.beem.api_key = String(b.beem.api_key).trim();
    if (b.beem.secret_key) c.beem.secret_key = String(b.beem.secret_key).trim();
    if (b.beem.sender !== undefined) c.beem.sender = String(b.beem.sender).trim().slice(0, 11) || 'INFO';
  }
  // sample applicants' phone numbers are made up and may belong to real people: never text them
  if (c.mode !== 'outbox' && !c.redirect_to && process.env.IGP_SAMPLE_DATA !== '0') {
    throw bad('This system holds sample data, so enter your demo phone number under "send every text to these numbers instead". Texts to the made-up sample numbers could reach real people.');
  }
  if (c.mode === 'android' && (!c.android.url || !c.android.username || !c.android.password)) throw bad('Enter the gateway address, username and password from the SMS Gateway app');
  if (c.mode === 'beem' && (!c.beem.api_key || !c.beem.secret_key)) throw bad('Enter the Beem API key and secret key');
  setSetting('sms', c);
  return publicConfig();
}

// Sign-up codes are shown on screen only while texts are not really being sent
const showCodesOnScreen = () => config().mode === 'outbox';

// ---------- gateways ----------
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

async function post(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

const GATEWAYS = {
  async android(c, to, message) {
    const r = await post(`${c.android.url}/message`, { authorization: basic(c.android.username, c.android.password) },
      { message, phoneNumbers: to.map((n) => '+' + n) });
    if (!r.ok) throw new Error(r.status === 401 ? 'Gateway rejected the username or password' : `Gateway answered ${r.status}: ${r.text.slice(0, 160)}`);
    return (r.json && r.json.id) || null;
  },
  async beem(c, to, message) {
    const r = await post('https://apisms.beem.africa/v1/send', { authorization: basic(c.beem.api_key, c.beem.secret_key) }, {
      source_addr: c.beem.sender, schedule_time: '', encoding: 0, message,
      recipients: to.map((n, i) => ({ recipient_id: i + 1, dest_addr: n })),
    });
    if (!r.ok || !r.json || r.json.successful === false) throw new Error(`Beem answered ${r.status}: ${(r.json && r.json.message) || r.text.slice(0, 160)}`);
    return r.json.request_id ? String(r.json.request_id) : null;
  },
};

async function deliver(c, msisdn, message) {
  const redirect = c.redirect_to ? c.redirect_to.split(',') : null;
  const to = redirect || [msisdn];
  const text = redirect ? `[Demo, for +${msisdn}] ${message}` : message;
  const ref = await GATEWAYS[c.mode](c, to, text);
  return { ref, sent_to: to.join(',') };
}

// ---------- worker ----------
let busy = false;
async function processQueue() {
  if (busy) return 0;
  busy = true;
  try {
    const c = config();
    if (c.mode === 'outbox') {
      run("UPDATE sms_outbox SET status = 'outbox' WHERE status = 'queued'");
      return 0;
    }
    // never send anything that was queued before this gateway was switched on
    run("UPDATE sms_outbox SET status = 'outbox' WHERE status = 'queued' AND created_at < ?", c.enabled_at || '9999');
    const rows = all(`SELECT * FROM sms_outbox WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
      ORDER BY id LIMIT 10`);
    for (const m of rows) {
      run("UPDATE sms_outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ?", m.id);
      try {
        const r = await deliver(c, m.msisdn, m.message);
        run("UPDATE sms_outbox SET status = 'sent', gateway = ?, gateway_ref = ?, sent_to = ?, sent_at = datetime('now'), last_error = NULL WHERE id = ?",
          c.mode, r.ref, r.sent_to, m.id);
      } catch (e) {
        const failed = m.attempts + 1 >= MAX_ATTEMPTS;
        run(`UPDATE sms_outbox SET status = ?, gateway = ?, last_error = ?, next_attempt_at = datetime('now', ?) WHERE id = ?`,
          failed ? 'failed' : 'queued', c.mode, String(e.message || e).slice(0, 300), `+${30 * (m.attempts + 1)} seconds`, m.id);
      }
    }
    return rows.length;
  } finally { busy = false; }
}

// Send one message right now (admin "Send test SMS"); records it in the outbox like any other message.
async function sendTest(to) {
  const c = config();
  if (c.mode === 'outbox') throw bad('Choose a gateway (Android phone or Beem) first – in outbox mode nothing is sent');
  const msisdn = normalise(to);
  const message = 'Test message from the Zanzibar Integrated Government Platform. SMS is working.';
  const id = Number(run("INSERT INTO sms_outbox(msisdn, message, status, attempts, gateway) VALUES(?,?, 'sending', 1, ?)", msisdn, message, c.mode).lastInsertRowid);
  try {
    // a test goes to the number typed in, not to the demo redirect
    const ref = await GATEWAYS[c.mode](c, [msisdn], message);
    run("UPDATE sms_outbox SET status = 'sent', gateway_ref = ?, sent_to = ?, sent_at = datetime('now') WHERE id = ?", ref, msisdn, id);
    return { ok: true, id, ref };
  } catch (e) {
    run("UPDATE sms_outbox SET status = 'failed', last_error = ? WHERE id = ?", String(e.message || e).slice(0, 300), id);
    const err = bad(`Not sent: ${e.cause && e.cause.code ? `cannot reach the gateway (${e.cause.code})` : e.message}`);
    throw err;
  }
}

function retry(id) {
  const m = one('SELECT * FROM sms_outbox WHERE id = ?', id);
  if (!m) throw bad('Message not found');
  if (!['failed', 'outbox'].includes(m.status)) throw bad('Only failed or unsent messages can be resent');
  if (config().mode === 'outbox') throw bad('Choose a gateway first');
  run("UPDATE sms_outbox SET status = 'queued', attempts = 0, next_attempt_at = NULL, last_error = NULL, created_at = datetime('now') WHERE id = ?", id);
}

module.exports = { config, publicConfig, updateConfig, showCodesOnScreen, processQueue, sendTest, retry, normalise, MODES };
