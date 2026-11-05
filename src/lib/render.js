'use strict';
const QR = require('qrcode');
const { parse } = require('./core');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PAGE_CSS = `
  *{box-sizing:border-box} body{margin:0;background:#e9ecef;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a}
  .sheet{max-width:820px;margin:24px auto;background:#fff;padding:48px 56px;border:10px double #0b5d3b;position:relative}
  .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0b5d3b;padding-bottom:16px}
  .gov{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#0b5d3b;font-family:system-ui,sans-serif;font-weight:700}
  h1{font-size:30px;margin:22px 0 4px} .sub{color:#555;font-family:system-ui,sans-serif;font-size:14px}
  table{width:100%;border-collapse:collapse;margin:24px 0;font-family:system-ui,sans-serif;font-size:14px}
  td{padding:8px 4px;border-bottom:1px solid #e3e3e3;vertical-align:top} td:first-child{color:#666;width:38%}
  .foot{display:flex;justify-content:space-between;align-items:flex-end;margin-top:24px;font-family:system-ui,sans-serif;font-size:12px;color:#555}
  .qr svg{width:120px;height:120px} .void{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:96px;color:rgba(200,0,0,.25);transform:rotate(-20deg);font-family:system-ui;font-weight:800;pointer-events:none}
  .bar{max-width:820px;margin:16px auto 0;display:flex;gap:8px;font-family:system-ui,sans-serif}
  .bar button{padding:8px 14px;border-radius:6px;border:1px solid #0b5d3b;background:#0b5d3b;color:#fff;cursor:pointer}
  @media print{.bar{display:none} body{background:#fff} .sheet{margin:0;border-width:6px}}
  @media (max-width:640px){.sheet{padding:24px 18px;margin:0} h1{font-size:22px}}`;

async function certificate(doc, baseUrl) {
  const data = parse(doc.data, {});
  const verifyUrl = `${baseUrl}/#/verify/${doc.verification_code}`;
  const qr = await QR.toString(verifyUrl, { type: 'svg', margin: 0 });
  const rows = [
    ['Certificate number', doc.number], ['Issued to', data.holder], ['ZanID', data.zan_id],
    data.business ? ['Business', `${data.business} (BRN ${data.brn})`] : null,
    ...Object.entries(data.form || {}).map(([k, v]) => [k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), v]),
    ['Application reference', data.reference], ['Issued on', doc.issued_at.slice(0, 10)], ['Valid until', doc.valid_until || 'No expiry'],
  ].filter(Boolean);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(doc.title)} ${esc(doc.number)}</title><style>${PAGE_CSS}</style></head><body>
  <div class="bar"><button onclick="print()">Print / save as PDF</button></div>
  <div class="sheet">${doc.revoked ? '<div class="void">REVOKED</div>' : ''}
    <div class="top"><div><div class="gov">Revolutionary Government of Zanzibar</div><div class="sub">${esc(data.agency)}</div></div>
    <div class="sub" style="text-align:right">Serikali ya Mapinduzi ya Zanzibar<br>Integrated Government Platform</div></div>
    <h1>${esc(doc.title)}</h1><div class="sub">${esc(data.service)}</div>
    <table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    <div class="foot"><div>Verify this document by scanning the code or visiting<br><b>${esc(baseUrl)}/#/verify</b> and entering<br>
    <span style="font-size:18px;font-weight:700;letter-spacing:.1em;color:#111">${esc(doc.verification_code)}</span></div>
    <div class="qr">${qr}</div></div>
  </div></body></html>`;
}

function receipt(p, app) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Receipt ${esc(p.receipt_no)}</title><style>${PAGE_CSS} .sheet{max-width:520px;border-width:4px}</style></head><body>
  <div class="bar" style="max-width:520px"><button onclick="print()">Print</button></div>
  <div class="sheet"><div class="gov">Revolutionary Government of Zanzibar</div><h1 style="font-size:24px">Payment receipt</h1>
  <table>
   <tr><td>Receipt number</td><td>${esc(p.receipt_no)}</td></tr><tr><td>Application</td><td>${esc(app.reference)} – ${esc(app.service_name)}</td></tr>
   <tr><td>Payer</td><td>${esc(app.applicant_name)}</td></tr><tr><td>Control number</td><td>${esc(p.control_number)}</td></tr>
   <tr><td>Amount</td><td>TZS ${Number(p.paid_amount || p.amount).toLocaleString()}</td></tr>
   <tr><td>Channel</td><td>${p.provider ? esc(p.provider_name || p.provider) + ' mobile money' : 'Counter'}</td></tr>
   <tr><td>Paid from</td><td>${esc(p.msisdn || '—')}</td></tr><tr><td>Transaction ref</td><td>${esc(p.provider_ref)}</td></tr>
   <tr><td>Date</td><td>${esc(p.paid_at)}</td></tr></table></div></body></html>`;
}

module.exports = { certificate, receipt, esc };
