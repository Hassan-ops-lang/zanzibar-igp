'use strict';
const express = require('express');
const { one, all, run } = require('../db');
const { bad, forbidden, notFound, audit } = require('../lib/core');
const { requireAuth, requireRole } = require('../lib/auth');
const { phaseLive } = require('../lib/records');
const pay = require('../lib/payments');
const wf = require('../lib/workflow');

const r = express.Router();
const baseUrl = (req) => process.env.IGP_INTERNAL_URL || `http://127.0.0.1:${req.socket.localPort}`;

// Provider callback – authenticated by HMAC signature, not by session. Raw body is captured in server.js.
r.post('/payments/callback/:provider', (req, res) => {
  const out = pay.handleCallback(req.params.provider, req.rawBody || '', req.headers['x-signature'], req);
  res.json(out);
});

r.get('/payments/providers', requireAuth, (_req, res) => {
  res.json(phaseLive('phase2') ? all('SELECT code, name, mode FROM payment_providers WHERE enabled = 1 ORDER BY name') : []);
});

r.post('/applications/:id/pay', requireAuth, async (req, res) => {
  const app = wf.getApp(req.params.id);
  const isApplicant = req.user.role === 'citizen' && req.user.person_id === app.person_id;
  const isDesk = req.user.role === 'front_office' && req.user.agency_id === app.service_agency_id;
  if (!isApplicant && !isDesk) throw forbidden();
  if (!phaseLive('phase2')) throw bad('Mobile money payments are not live yet – pay at a government cashier');
  if (['rejected', 'withdrawn'].includes(app.status)) throw bad('Application is closed');
  const p = one('SELECT * FROM payments WHERE application_id = ?', app.id);
  if (!p) throw bad('No fee is due for this application');
  res.json(await pay.initiate(req, p, req.body.provider, req.body.msisdn));
});

r.get('/payments/:id/receipt', requireAuth, (req, res) => {
  const p = one('SELECT py.*, pp.name AS provider_name FROM payments py LEFT JOIN payment_providers pp ON pp.code = py.provider WHERE py.id = ?', req.params.id);
  if (!p || p.status !== 'paid') throw notFound('Receipt not available');
  const app = wf.getApp(p.application_id);
  wf.assertView(req.user, app);
  res.type('html').send(require('../lib/render').receipt(p, app));
});

// ---------- sandbox mobile network (handset simulator for the sandbox providers) ----------
r.get('/sandbox/prompts', (req, res) => {
  const m = req.query.msisdn ? pay.normaliseMsisdn(req.query.msisdn) : null;
  if (!m) throw bad('Enter the phone number');
  res.json(all(`SELECT sp.*, pp.name AS provider_name FROM sandbox_prompts sp JOIN payment_providers pp ON pp.code = sp.provider
    WHERE sp.msisdn = ? ORDER BY sp.id DESC LIMIT 10`, m));
});
r.post('/sandbox/prompts/:id/respond', async (req, res) => {
  res.json(await pay.sandboxRespond(Number(req.params.id), !!req.body.approve, req.body.pin, baseUrl(req)));
});

// ---------- finance ----------
const fin = express.Router();
fin.use(requireRole('finance', 'admin'));

fin.get('/summary', (_req, res) => {
  res.json({
    today: one("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM payments WHERE status = 'paid' AND date(paid_at) = date('now')"),
    month: one("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM payments WHERE status = 'paid' AND paid_at >= date('now','start of month')"),
    unreconciled: one("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM payments WHERE status = 'paid' AND reconciled = 0"),
    outstanding: one("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM payments WHERE status IN ('unpaid','pending','failed')"),
    by_provider: all(`SELECT COALESCE(pp.name, 'Counter') AS provider, COUNT(*) AS n, SUM(py.amount) AS amount FROM payments py
      LEFT JOIN payment_providers pp ON pp.code = py.provider WHERE py.status = 'paid' GROUP BY py.provider ORDER BY amount DESC`),
    by_agency: all(`SELECT a.name AS agency, COUNT(*) AS n, SUM(py.amount) AS amount FROM payments py JOIN applications ap ON ap.id = py.application_id
      JOIN services s ON s.id = ap.service_id JOIN agencies a ON a.id = s.agency_id WHERE py.status = 'paid' GROUP BY a.id ORDER BY amount DESC`),
    alerts: all("SELECT * FROM alerts WHERE audience = 'finance' AND status = 'open' ORDER BY id DESC LIMIT 50"),
  });
});

fin.get('/payments', (req, res) => {
  const w = []; const p = [];
  if (req.query.status) { w.push('py.status = ?'); p.push(req.query.status); }
  if (req.query.reconciled === '0' || req.query.reconciled === '1') { w.push('py.reconciled = ?'); p.push(Number(req.query.reconciled)); }
  if (req.query.q) { w.push('(py.control_number LIKE ? OR ap.reference LIKE ? OR py.provider_ref LIKE ?)'); const q = `%${req.query.q}%`; p.push(q, q, q); }
  res.json(all(`SELECT py.*, ap.reference, s.name AS service, a.name AS agency, pe.full_name AS payer, pp.name AS provider_name
    FROM payments py JOIN applications ap ON ap.id = py.application_id JOIN services s ON s.id = ap.service_id
    JOIN agencies a ON a.id = s.agency_id JOIN persons pe ON pe.id = ap.person_id LEFT JOIN payment_providers pp ON pp.code = py.provider
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY COALESCE(py.paid_at, py.created_at) DESC LIMIT 500`, ...p));
});

fin.post('/statement', (req, res) => res.json(pay.importStatement(req, req.body.provider, req.body.csv)));
fin.get('/statement', (req, res) => {
  const prov = one('SELECT * FROM payment_providers WHERE code = ?', req.query.provider);
  if (!prov) throw bad('Unknown provider');
  if (prov.mode !== 'sandbox') throw bad('Download live statements from the provider portal, then import them here');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : new Date().toISOString().slice(0, 10);
  audit(req, 'finance.fetch_statement', 'provider', prov.code, { day });
  res.json({ provider: prov.code, day, csv: pay.sandboxStatement(prov.code, day) });
});
fin.get('/statement-lines', (_req, res) => {
  res.json(all('SELECT sl.*, u.full_name AS imported_by_name FROM statement_lines sl LEFT JOIN users u ON u.id = sl.imported_by ORDER BY sl.id DESC LIMIT 200'));
});
fin.post('/payments/:id/counter', (req, res) => {
  const p = one('SELECT * FROM payments WHERE id = ?', req.params.id);
  if (!p) throw notFound();
  res.json(pay.recordCounterPayment(req, p, req.body.reference));
});
fin.post('/payments/:id/reconcile', (req, res) => {
  const p = one('SELECT * FROM payments WHERE id = ?', req.params.id);
  if (!p || p.status !== 'paid') throw bad('Only paid items can be reconciled');
  if (!req.body.note) throw bad('Record the evidence used to reconcile manually');
  run("UPDATE payments SET reconciled = 1, reconciled_by = ?, reconciled_at = datetime('now') WHERE id = ?", req.user.id, p.id);
  audit(req, 'finance.manual_reconcile', 'payment', p.id, { note: req.body.note });
  res.json({ ok: true });
});

r.use('/finance', fin);
module.exports = r;
