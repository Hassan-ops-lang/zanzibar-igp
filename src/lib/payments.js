'use strict';
/*
 * Government-to-Telco mobile money integration (Phase 2).
 *
 * Every provider implements:  push({ msisdn, amount, control_number, provider_ref })  -> initiates a payment prompt
 * and calls back  POST /api/payments/callback/:provider  with a JSON body signed by
 * header  X-Signature: hex(HMAC-SHA256(callback_secret, rawBody)).
 *
 * mode = 'sandbox' : prompts go to the built-in sandbox network (see /sandbox/phone), which signs and posts the
 *                    callback exactly as a live provider would.
 * mode = 'live'    : the push is POSTed to the provider's api_base (/push) and the provider calls back over the
 *                    internet. Configure api_base and callback_secret under Admin → Payment providers.
 */
const crypto = require('node:crypto');
const { one, all, run, tx } = require('../db');
const { bad, notFound, notifyPerson, audit, nowSql } = require('./core');

const sign = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');

function normaliseMsisdn(m) {
  let s = String(m || '').replace(/[^\d]/g, '');
  if (s.startsWith('0')) s = '255' + s.slice(1);
  if (!/^255[67]\d{8}$/.test(s)) throw bad('Enter a valid Tanzanian mobile number, e.g. 0777 123 456');
  return s;
}

async function initiate(req, payment, providerCode, msisdnRaw) {
  const provider = one('SELECT * FROM payment_providers WHERE code = ? AND enabled = 1', providerCode);
  if (!provider) throw bad('Choose a mobile money provider');
  if (payment.status === 'paid') throw bad('This fee is already paid');
  const msisdn = normaliseMsisdn(msisdnRaw);
  const providerRef = `${provider.code.toUpperCase()}${Date.now().toString(36).toUpperCase()}${crypto.randomInt(100, 999)}`;
  run("UPDATE payments SET status = 'pending', provider = ?, msisdn = ?, provider_ref = ?, initiated_at = datetime('now') WHERE id = ?",
    provider.code, msisdn, providerRef, payment.id);
  const body = { msisdn, amount: payment.amount, currency: payment.currency, control_number: payment.control_number, provider_ref: providerRef };
  if (provider.mode === 'live') {
    const raw = JSON.stringify(body);
    const res = await fetch(`${provider.api_base.replace(/\/$/, '')}/push`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sign(provider.callback_secret, raw) }, body: raw,
    });
    if (!res.ok) {
      run("UPDATE payments SET status = 'failed' WHERE id = ?", payment.id);
      throw bad(`${provider.name} did not accept the request (${res.status})`);
    }
  } else {
    run('INSERT INTO sandbox_prompts(provider, msisdn, amount, control_number, provider_ref) VALUES(?,?,?,?,?)',
      provider.code, msisdn, payment.amount, payment.control_number, providerRef);
  }
  audit(req, 'payment.initiate', 'payment', payment.id, { provider: provider.code, msisdn });
  return { provider_ref: providerRef, provider: provider.name, mode: provider.mode, msisdn };
}

// Process a signed provider callback. Returns { ok, outcome }.
function handleCallback(providerCode, rawBody, signature, req) {
  const provider = one('SELECT * FROM payment_providers WHERE code = ?', providerCode);
  const log = (ok, outcome) => run('INSERT INTO payment_callbacks(provider, body, signature_ok, outcome) VALUES(?,?,?,?)', providerCode, rawBody, ok ? 1 : 0, outcome);
  if (!provider) { log(false, 'unknown_provider'); throw notFound('Unknown provider'); }
  const expected = sign(provider.callback_secret, rawBody);
  const okSig = signature && signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!okSig) { log(false, 'bad_signature'); const e = bad('Invalid signature'); e.status = 401; throw e; }
  let b; try { b = JSON.parse(rawBody); } catch { log(true, 'bad_json'); throw bad('Invalid JSON'); }

  const pay = one('SELECT * FROM payments WHERE control_number = ?', String(b.control_number || ''));
  if (!pay) {
    log(true, 'unmatched');
    raiseFinanceAlert('unmatched_callback', `cb:${providerCode}:${b.provider_ref}`, 'Mobile money payment with unknown control number',
      `${provider.name} reported ${b.amount} TZS for control number ${b.control_number} (ref ${b.provider_ref}) which matches no bill.`);
    return { ok: true, outcome: 'unmatched' };
  }
  if (pay.status === 'paid') { log(true, 'duplicate'); return { ok: true, outcome: 'duplicate' }; }
  if (b.status !== 'SUCCESS') {
    run("UPDATE payments SET status = 'failed' WHERE id = ?", pay.id);
    log(true, 'failed');
    const app = one('SELECT person_id, reference FROM applications WHERE id = ?', pay.application_id);
    notifyPerson(app.person_id, pay.application_id, `${app.reference}: mobile money payment was not completed (${b.reason || 'declined'}). You can try again.`);
    return { ok: true, outcome: 'failed' };
  }
  if (Number(b.amount) !== pay.amount) {
    log(true, 'amount_mismatch');
    raiseFinanceAlert('amount_mismatch', `amt:${pay.id}:${b.provider_ref}`, `Payment amount mismatch on ${pay.control_number}`,
      `Expected TZS ${pay.amount}, provider reported TZS ${b.amount} (ref ${b.provider_ref}). Payment held for finance review.`, pay.application_id);
    return { ok: true, outcome: 'amount_mismatch' };
  }
  const receipt = `RCT-${new Date().getFullYear()}-${String(pay.id).padStart(7, '0')}`;
  tx(() => {
    run(`UPDATE payments SET status = 'paid', paid_amount = ?, receipt_no = ?, paid_at = datetime('now'),
         provider = ?, provider_ref = COALESCE(?, provider_ref), msisdn = COALESCE(?, msisdn) WHERE id = ?`,
    Number(b.amount), receipt, providerCode, b.provider_ref || null, b.msisdn || null, pay.id);
    require('./workflow').onPaid(pay.application_id, null);
  });
  log(true, 'paid');
  const app = one('SELECT person_id, reference FROM applications WHERE id = ?', pay.application_id);
  notifyPerson(app.person_id, pay.application_id, `Payment of TZS ${pay.amount.toLocaleString()} received for ${app.reference}. Receipt ${receipt}.`);
  audit(req, 'payment.callback_paid', 'payment', pay.id, { provider: providerCode, receipt });
  return { ok: true, outcome: 'paid', receipt };
}

function raiseFinanceAlert(rule, fingerprint, title, detail, appId = null) {
  run(`INSERT OR IGNORE INTO alerts(rule, severity, agency_id, entity, entity_id, fingerprint, title, detail, audience)
       VALUES(?, 'high', NULL, ?, ?, ?, ?, ?, 'finance')`, rule, appId ? 'application' : 'payment', appId, fingerprint, title, detail);
}

// Sandbox handset approves/declines a prompt → the sandbox network posts a signed callback to our own endpoint.
async function sandboxRespond(promptId, approve, pin, baseUrl) {
  const p = one('SELECT * FROM sandbox_prompts WHERE id = ?', promptId);
  if (!p) throw notFound('Prompt not found');
  if (p.status !== 'waiting') throw bad('Prompt already answered');
  if (approve && !/^\d{4}$/.test(String(pin || ''))) throw bad('Enter your 4-digit PIN');
  run('UPDATE sandbox_prompts SET status = ? WHERE id = ?', approve ? 'approved' : 'declined', p.id);
  const provider = one('SELECT * FROM payment_providers WHERE code = ?', p.provider);
  const raw = JSON.stringify({
    provider_ref: p.provider_ref, control_number: p.control_number, amount: p.amount, msisdn: p.msisdn,
    status: approve ? 'SUCCESS' : 'FAILED', reason: approve ? undefined : 'Declined by customer', txn_time: new Date().toISOString(),
  });
  const res = await fetch(`${baseUrl}/api/payments/callback/${p.provider}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sign(provider.callback_secret, raw) }, body: raw,
  });
  return res.json();
}

// Provider settlement statement (CSV: provider_ref,control_number,amount,txn_date)
function sandboxStatement(providerCode, day) {
  const rows = all(`SELECT provider_ref, control_number, amount, created_at FROM sandbox_prompts
    WHERE provider = ? AND status = 'approved' AND date(created_at) = ?`, providerCode, day);
  return ['provider_ref,control_number,amount,txn_date', ...rows.map((r) => `${r.provider_ref},${r.control_number},${r.amount},${r.created_at}`)].join('\n');
}

function importStatement(req, providerCode, csv) {
  const provider = one('SELECT * FROM payment_providers WHERE code = ?', providerCode);
  if (!provider) throw bad('Unknown provider');
  const lines = String(csv || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw bad('Statement is empty');
  const start = /provider_ref/i.test(lines[0]) ? 1 : 0;
  const result = { matched: 0, mismatch: 0, unmatched: 0, already: 0 };
  tx(() => {
    for (const line of lines.slice(start)) {
      const [ref, cn, amt, date] = line.split(',').map((s) => s.trim());
      const amount = Number(amt);
      const pay = one('SELECT * FROM payments WHERE control_number = ? OR (provider_ref = ? AND provider_ref IS NOT NULL)', cn, ref);
      let status;
      if (!pay) { status = 'unmatched'; result.unmatched++;
        raiseFinanceAlert('statement_unmatched', `st:${providerCode}:${ref}`, 'Statement line matches no bill', `${provider.name} line ${ref} / ${cn} / TZS ${amount}`);
      } else if (pay.status !== 'paid' || pay.amount !== amount) { status = 'mismatch'; result.mismatch++;
        raiseFinanceAlert('statement_mismatch', `stm:${pay.id}:${ref}`, `Statement disagrees with records for ${pay.control_number}`,
          `Statement: TZS ${amount}; system: TZS ${pay.amount}, status ${pay.status}`, pay.application_id);
      } else if (pay.reconciled) { status = 'already'; result.already++;
      } else {
        status = 'matched'; result.matched++;
        run("UPDATE payments SET reconciled = 1, reconciled_by = ?, reconciled_at = datetime('now') WHERE id = ?", req.user.id, pay.id);
      }
      run('INSERT INTO statement_lines(provider, provider_ref, control_number, amount, txn_date, match_status, payment_id, imported_by) VALUES(?,?,?,?,?,?,?,?)',
        providerCode, ref, cn, amount, date || null, status, pay ? pay.id : null, req.user.id);
    }
  });
  audit(req, 'finance.import_statement', 'provider', providerCode, result);
  return result;
}

// Over-the-counter payment recorded by finance (for applicants assisted at a desk or before Phase 2 goes live)
function recordCounterPayment(req, payment, receiptRef) {
  if (payment.status === 'paid') throw bad('Already paid');
  if (!receiptRef) throw bad('Enter the counter receipt / bank slip reference');
  const receipt = `RCT-${new Date().getFullYear()}-${String(payment.id).padStart(7, '0')}`;
  tx(() => {
    run(`UPDATE payments SET status = 'paid', provider = NULL, provider_ref = ?, paid_amount = amount, receipt_no = ?,
         paid_at = datetime('now'), reconciled = 1, reconciled_by = ?, reconciled_at = datetime('now') WHERE id = ?`,
    `COUNTER:${receiptRef}`, receipt, req.user.id, payment.id);
    require('./workflow').onPaid(payment.application_id, req, 'counter payment');
  });
  audit(req, 'finance.counter_payment', 'payment', payment.id, { receiptRef });
  return { receipt };
}

module.exports = { initiate, handleCallback, sandboxRespond, sandboxStatement, importStatement, recordCounterPayment, normaliseMsisdn, sign, nowSql };
