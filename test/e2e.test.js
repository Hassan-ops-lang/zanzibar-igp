'use strict';
/* End-to-end test of the full business-permit walkthrough plus integration, finance and SIP, over real HTTP. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.IGP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-test-'));
const { createApp } = require('../src/server');
const { samplePdf, DEFAULT_PASSWORD } = require('../src/seed');

let server; let base;
test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(process.env.IGP_DATA_DIR, { recursive: true, force: true }); });

async function login(username) {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: DEFAULT_PASSWORD }) });
  assert.equal(r.status, 200, `login ${username}`);
  const { token } = await r.json();
  return async (p, opts = {}) => {
    const o = { method: opts.method || (opts.body || opts.form ? 'POST' : 'GET'), headers: { authorization: `Bearer ${token}`, ...(opts.headers || {}) } };
    if (opts.form) o.body = opts.form; else if (opts.body) { o.body = JSON.stringify(opts.body); o.headers['content-type'] = 'application/json'; }
    const res = await fetch(base + '/api' + p, o);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (opts.expect) assert.equal(res.status, opts.expect, `${p}: ${JSON.stringify(data)}`);
    else assert.ok(res.ok, `${o.method} ${p} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}
const pdf = (t) => new Blob([samplePdf(t)], { type: 'application/pdf' });

test('presidential walkthrough: apply → request document → upload → review → pay → issue → SIP', async () => {
  const amina = await login('amina');
  const desk = await login('zmc.desk');
  const officer = await login('zmc.officer');
  const fire = await login('fire.officer');

  // 01 Apply using existing registration details (verified records reused)
  const me = await amina('/auth/me');
  const biz = me.user.person.businesses[0];
  const svc = (await amina('/services')).find((s) => s.code === 'BUSINESS_LICENCE');
  const detail = await amina(`/services/${svc.id}?business_id=${biz.id}`);
  const reused = detail.resolved_docs.filter((d) => d.satisfied_by_record).map((d) => d.code);
  assert.deepEqual(reused.sort(), ['fire', 'owner_id', 'registration', 'tax_clearance', 'tin']);
  assert.equal(detail.prefill.premises_address, biz.address);

  const fd = new FormData();
  fd.append('payload', JSON.stringify({ service_id: svc.id, business_id: biz.id, form: { activity: 'Retail shop', premises_address: biz.address, employees: 4, start_date: '2026-12-01' } }));
  const { id, reference } = await amina('/applications', { form: fd });
  assert.match(reference, /^ZNZ-\d{4}-\d{6}$/);

  // duplicate application is refused
  const fd2 = new FormData(); fd2.append('payload', fd.get('payload'));
  await amina('/applications', { form: fd2, expect: 400 });

  // front office cannot route while the lease is missing; requests it through the portal
  await desk(`/applications/${id}/route`, { body: {}, expect: 400 });
  await desk(`/applications/${id}/request-document`, { body: { doc_code: 'lease', label: 'Signed premises lease or title', message: 'Please upload the signed lease' } });
  let a = await amina(`/applications/${id}`);
  assert.equal(a.status, 'awaiting_applicant');

  // 02 Owner uploads the document
  const up = new FormData(); up.append('doc_code', 'lease'); up.append('file', pdf('Lease for Amina Spice House'), 'lease.pdf');
  await amina(`/applications/${id}/documents`, { form: up });
  a = await amina(`/applications/${id}`);
  assert.equal(a.status, 'submitted');

  // front office routes; standard Fire referral is created automatically
  const staff = await desk('/staff');
  await desk(`/applications/${id}/route`, { body: { assign_to: staff.find((s) => s.role === 'back_office').id } });
  a = await officer(`/applications/${id}`);
  assert.equal(a.status, 'in_review');
  assert.equal(a.referrals.length, 1);
  assert.ok(a.verified_records.length >= 5, 'officer sees verified records');

  // cannot approve while referral is open; the fire office answers it
  await officer(`/applications/${id}/approve`, { body: {}, expect: 400 });
  const refs = await fire('/referrals');
  const ref = refs.find((r) => r.reference === reference);
  await fire(`/referrals/${ref.id}/answer`, { body: { outcome: 'cleared', note: 'Premises inspected' } });
  await officer(`/applications/${id}/approve`, { body: { note: 'All clear' } });
  a = await amina(`/applications/${id}`);
  assert.equal(a.status, 'awaiting_payment');

  // cannot issue before payment
  await officer(`/applications/${id}/issue`, { body: {}, expect: 400 });

  // pay by (sandbox) mobile money: push → handset PIN → signed callback
  const push = await amina(`/applications/${id}/pay`, { body: { provider: 'mpesa', msisdn: '0777 123 456' } });
  assert.equal(push.msisdn, '255777123456');
  const prompts = await (await fetch(`${base}/api/sandbox/prompts?msisdn=255777123456`)).json();
  const pr = prompts.find((p) => p.status === 'waiting');
  const cb = await (await fetch(`${base}/api/sandbox/prompts/${pr.id}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: true, pin: '1234' }) })).json();
  assert.equal(cb.outcome, 'paid');
  a = await officer(`/applications/${id}`);
  assert.equal(a.payment.status, 'paid');
  assert.equal(a.status, 'approved');

  // forged callback is rejected
  const bad = await fetch(`${base}/api/payments/callback/mpesa`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'deadbeef' }, body: '{"control_number":"x"}' });
  assert.equal(bad.status, 401);

  // 03 Back office issues under the original reference; certificate verifies publicly
  const iss = await officer(`/applications/${id}/issue`, { body: {} });
  a = await amina(`/applications/${id}`);
  assert.equal(a.status, 'issued');
  assert.equal(a.reference, reference);
  const cert = await amina(`/applications/${id}/certificate`);
  assert.match(cert, /Business Licence/);
  const v = await (await fetch(`${base}/api/verify/${iss.verification_code}`)).json();
  assert.equal(v.valid, true);

  // the licence is now a verified record other offices can reuse
  const recs = await amina('/me/records');
  assert.ok(recs.records.some((r) => r.record_type === 'business_licence'));

  // SIP shows the completed case to the ministry leader
  const leader = await login('zmc.leader');
  const o = await leader('/sip/overview');
  assert.equal(o.scope, 'ministry');
  assert.ok(o.metrics.by_status.issued >= 1);
  const exec = await login('executive');
  const eo = await exec('/sip/overview');
  assert.ok(eo.ministries.length >= 9);

  // finance reconciles today's sandbox statement
  const finance = await login('finance');
  const st = await finance('/finance/statement?provider=mpesa');
  const res = await finance('/finance/statement', { body: { provider: 'mpesa', csv: st.csv } });
  assert.ok(res.matched >= 1);
});

test('access control and audit', async () => {
  const said = await login('said');
  const amina = await login('amina');
  const mine = await amina('/applications');
  await said(`/applications/${mine[0].id}`, { expect: 403 });

  const leader = await login('zfda.leader');
  await leader('/sip/links?q=amina&purpose=test-case', { expect: 403 });
  const sec = await login('security');
  await sec('/sip/links?q=Amina', { expect: 400 }); // purpose required
  const g = await sec('/sip/links?q=Amina&purpose=CASE-2026-001');
  assert.ok(g.nodes.length > 0);

  const admin = await login('admin');
  const audit = await admin('/admin/audit?action=sip.link_search');
  assert.ok(audit.some((r) => r.purpose === 'CASE-2026-001'));
  const chain = await admin('/admin/audit/verify');
  assert.equal(chain.ok, true);
});

test('inter-agency API: scoped record reads, publishing and referral answers', async () => {
  const admin = await login('admin');
  const ags = await admin('/admin/agencies');
  const zrb = ags.find((a) => a.code === 'ZRB'); const frf = ags.find((a) => a.code === 'FRF');
  const { key } = await admin('/admin/api-keys', { body: { agency_id: zrb.id, label: 'ZRB tax system' } });
  const x = (p, o = {}) => fetch(base + '/api/x/v1' + p, { method: o.body ? 'POST' : 'GET', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined });

  assert.equal((await fetch(base + '/api/x/v1/whoami')).status, 401);
  const amina = await (await login('amina'))('/auth/me');
  const brn = amina.user.person.businesses[0].brn;
  const b = await (await x(`/businesses/${brn}`)).json();
  assert.ok(b.records.every((r) => ['business_registration', 'tin', 'tax_clearance', 'business_licence'].includes(r.record_type)));
  assert.ok(!b.records.some((r) => r.record_type === 'fire_certificate'), 'ZRB has no grant for fire certificates');

  const pub = await x('/records', { body: { record_type: 'tax_clearance', brn, number: 'TC/NEW/1', valid_until: '2027-12-31' } });
  assert.equal(pub.status, 201);
  const forbidden = await x('/records', { body: { record_type: 'fire_certificate', brn, number: 'X' } });
  assert.equal(forbidden.status, 403);

  // fire service answers a referral through its own system
  const fk = (await admin('/admin/api-keys', { body: { agency_id: frf.id } })).key;
  const list = await (await fetch(base + '/api/x/v1/referrals', { headers: { 'x-api-key': fk } })).json();
  if (list.length) {
    const r = await fetch(`${base}/api/x/v1/referrals/${list[0].id}/answer`, { method: 'POST', headers: { 'x-api-key': fk, 'content-type': 'application/json' }, body: JSON.stringify({ outcome: 'cleared', note: 'via API' }) });
    assert.equal(r.status, 200);
  }
});

test('citizen self-registration against the civil registry', async () => {
  const admin = await login('admin');
  const p = (await admin('/admin/persons?q=')).find((x) => x.phone && x.zan_id !== '100000013');
  const post = (u, b) => fetch(base + '/api/auth' + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  assert.equal((await post('/register/start', { zan_id: p.zan_id, dob: '1900-01-01' })).status, 400);
  const s = await (await post('/register/start', { zan_id: p.zan_id, dob: p.dob })).json();
  assert.ok(s.sandbox_code);
  const c = await post('/register/complete', { zan_id: p.zan_id, code: s.sandbox_code, username: 'newuser1', password: 'Passw0rd!' });
  assert.equal(c.status, 200);
});
