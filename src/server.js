'use strict';
const path = require('node:path');
const express = require('express');
const { one, all } = require('./db');
const { HttpError, audit, parse } = require('./lib/core');
const { loadUser } = require('./lib/auth');
const sip = require('./lib/sip');

function createApp() {
  if (!one('SELECT 1 FROM agencies LIMIT 1')) require('./seed').seed({ sample: process.env.IGP_SAMPLE_DATA !== '0' });

  const app = express();
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use(express.urlencoded({ extended: false }));
  app.use(loadUser);

  // CSRF protection for cookie-authenticated, state-changing requests: require same-origin
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/payments/callback') || req.path.startsWith('/x/')) return next();
    if ((req.headers.authorization || '').startsWith('Bearer ')) return next();
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return next(new HttpError(403, 'Cross-origin request blocked'));
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // Public document verification
  app.get('/api/verify/:code', (req, res) => {
    const d = one(`SELECT d.number, d.title, d.issued_at, d.valid_until, d.revoked, d.data, ap.status FROM issued_documents d
      JOIN applications ap ON ap.id = d.application_id WHERE d.verification_code = ?`, String(req.params.code).toUpperCase().trim());
    audit(req, 'public.verify', 'issued_document', req.params.code, { found: !!d });
    if (!d) return res.status(404).json({ valid: false, message: 'No document with this verification code' });
    const data = parse(d.data, {});
    const expired = d.valid_until && d.valid_until < new Date().toISOString().slice(0, 10);
    res.json({ valid: !d.revoked && !expired, revoked: !!d.revoked, expired: !!expired, number: d.number, title: d.title,
      holder: data.holder, business: data.business, agency: data.agency, issued_at: d.issued_at, valid_until: d.valid_until });
  });

  if (process.env.IGP_DISABLE_SANDBOX === '1') app.use('/api/sandbox', (_q, _r, n) => n(new HttpError(404, 'Sandbox disabled')));

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/x/v1', require('./routes/xapi'));
  app.use('/api/sip', require('./routes/sip'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api', require('./routes/payments'));
  app.use('/api', require('./routes/applications'));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message || 'Server error';
    if (err.code === 'LIMIT_FILE_SIZE') { status = 400; message = 'File too large (maximum 10 MB)'; }
    if (/UNIQUE constraint failed/.test(message)) { status = 409; message = 'That record already exists'; }
    if (status >= 500) { console.error(err); message = 'Something went wrong. The error has been logged.'; }
    res.status(status).json({ error: message });
  });
  return app;
}

function startJobs() {
  const tick = () => { try { sip.runRules(); } catch (e) { console.error('rules', e); } };
  tick();
  const t1 = setInterval(tick, 60e3);
  const snap = () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (!one('SELECT 1 FROM sip_snapshots WHERE day = ?', today)) sip.snapshot();
    } catch (e) { console.error('snapshot', e); }
  };
  snap();
  const t2 = setInterval(snap, 15 * 60e3);
  return () => { clearInterval(t1); clearInterval(t2); };
}

if (require.main === module) {
  const app = createApp();
  startJobs();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    const n = all('SELECT COUNT(*) AS n FROM users')[0].n;
    console.log(`Integrated Government Platform running on http://localhost:${port}  (${n} user accounts)`);
  });
}

module.exports = { createApp, startJobs };
