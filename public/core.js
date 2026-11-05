/* Integrated Government Platform – client core: state, API, templating, router, shell */
'use strict';

const S = { me: null, phases: {}, sip: false, providers: null };

// ---------- templating (auto-escaping) ----------
const RAW = Symbol('raw');
const raw = (s) => ({ [RAW]: String(s) });
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function val(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(val).join('');
  if (typeof v === 'object' && v[RAW] !== undefined) return v[RAW];
  return esc(v);
}
function h(strings, ...vals) { let out = strings[0]; vals.forEach((v, i) => { out += val(v) + strings[i + 1]; }); return raw(out); }
const str = (t) => (t && t[RAW] !== undefined ? t[RAW] : String(t));

// ---------- formatting ----------
const money = (n) => `TZS ${Number(n || 0).toLocaleString('en-US')}`;
const asDate = (s) => (s ? new Date(String(s).replace(' ', 'T') + (String(s).length <= 19 && !String(s).endsWith('Z') ? 'Z' : '')) : null);
const fmtDate = (s) => { const d = asDate(s); return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; };
const fmtDateTime = (s) => { const d = asDate(s); return d ? d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; };
const ago = (s) => {
  const d = asDate(s); if (!d) return '';
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`; const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`; const dy = Math.round(hr / 24); return `${dy} day${dy > 1 ? 's' : ''} ago`;
};
const STATUS = {
  submitted: ['Submitted', 'info'], awaiting_applicant: ['Action needed', 'warn'], in_review: ['Under review', 'info'],
  awaiting_payment: ['Awaiting payment', 'warn'], approved: ['Approved', 'good'], issued: ['Issued', 'good'],
  rejected: ['Rejected', 'bad'], withdrawn: ['Withdrawn', ''],
};
const statusBadge = (s) => { const [l, c] = STATUS[s] || [s, '']; return h`<span class="badge ${c}">${l}</span>`; };
const SEV = { high: ['Critical', 'bad', '▲'], medium: ['Warning', 'warn', '●'], low: ['Notice', 'info', '◆'] };
const sevBadge = (s) => { const [l, c, i] = SEV[s] || [s, '', '']; return h`<span class="badge ${c}">${i} ${l}</span>`; };
const payBadge = (s) => ({ paid: h`<span class="badge good">✓ Paid</span>`, pending: h`<span class="badge warn">Pending</span>`, failed: h`<span class="badge bad">Failed</span>`, unpaid: h`<span class="badge">Unpaid</span>` }[s] || (s ? h`<span class="badge">${s}</span>` : h`<span class="muted">No fee</span>`));

// ---------- API ----------
async function api(path, opts = {}) {
  const o = { method: opts.method || (opts.body || opts.form ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
  if (opts.form) o.body = opts.form;
  else if (opts.body !== undefined) { o.body = JSON.stringify(opts.body); o.headers['content-type'] = 'application/json'; }
  const res = await fetch('/api' + path, o);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && S.me && !path.startsWith('/auth')) { S.me = null; location.hash = '#/login'; }
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}
const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v); const s = p.toString(); return s ? '?' + s : ''; };

// ---------- UI helpers ----------
function toast(msg, err = false) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), err ? 5000 : 3000);
}
function modal(title, body, { submit = 'Save', danger = false, wide = false, onSubmit = null } = {}) {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = str(h`<form class="modal" ${raw(wide ? 'style="width:min(820px,100%)"' : '')} novalidate><div class="card-h"><h2>${title}</h2><button type="button" class="btn link" data-x aria-label="Close">✕</button></div>
      <div class="card-b">${body}<div class="notice bad" data-err style="display:none"></div>
      <div class="row" style="justify-content:flex-end;margin-top:8px"><button type="button" class="btn" data-x>Cancel</button>
      ${submit ? h`<button class="btn ${danger ? 'danger' : 'primary'}" data-submit>${submit}</button>` : ''}</div></div></form>`);
    const close = (v) => { bg.remove(); resolve(v); };
    bg.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => close(null); });
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(null); });
    const form = bg.querySelector('form');
    const err = form.querySelector('[data-err]');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form); const obj = Object.fromEntries(fd.entries()); obj.__fd = fd;
      if (!onSubmit) return close(obj);
      const btn = form.querySelector('[data-submit]'); if (btn) btn.disabled = true; err.style.display = 'none';
      try { const r = await onSubmit(obj, form); close(r === undefined ? true : r); }
      catch (ex) { err.textContent = ex.message; err.style.display = ''; }
      finally { if (btn) btn.disabled = false; }
    };
    document.body.appendChild(bg);
    const first = form.querySelector('input:not([type=hidden]),select,textarea'); if (first) first.focus();
  });
}
// open a form modal whose submit runs `fn`; errors keep the modal open
const modalAction = (title, body, fn, opts = {}) => modal(title, body, { ...opts, onSubmit: fn });
const confirmBox = (title, text, submit = 'Confirm', danger = false) => modal(title, h`<p>${text}</p>`, { submit, danger });
const card = (title, body, actions = '') => h`<section class="card">${title ? h`<div class="card-h"><h2>${title}</h2><div class="row">${actions}</div></div>` : ''}<div class="card-b">${body}</div></section>`;
const statTile = (label, value, sub = '') => h`<div class="card stat"><div class="label">${label}</div><div class="value">${value}</div>${sub ? h`<div class="sub">${sub}</div>` : ''}</div>`;
const empty = (t) => h`<div class="empty">${t}</div>`;
const dl = (pairs) => h`<dl class="kv">${pairs.filter(Boolean).map(([k, v]) => h`<dt>${k}</dt><dd>${v == null || v === '' ? '—' : v}</dd>`)}</dl>`;

// grouped bar chart (2 series) with hover tooltip, legend and accessible table
function barChart(rows, series, { height = 200, label = (r) => r.label } = {}) {
  const W = 680, H = height, pl = 30, pb = 22, pt = 8;
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key] || 0)));
  const nice = Math.ceil(max / 4) * 4 || 4;
  const gw = (W - pl) / rows.length; const bw = Math.max(3, Math.min(14, (gw - 8) / series.length - 2));
  const y = (v) => pt + (H - pt - pb) * (1 - v / nice);
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = (nice / 4) * i; g += `<line x1="${pl}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)" stroke-width="1"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${v}</text>`; }
  rows.forEach((r, i) => {
    const cx = pl + gw * i + gw / 2; const tot = series.length * (bw + 2) - 2;
    series.forEach((s, j) => {
      const v = r[s.key] || 0; const x = cx - tot / 2 + j * (bw + 2); const top = y(v); const hgt = Math.max(0, H - pb - top);
      if (hgt > 0) g += `<path d="M${x},${H - pb} V${top + Math.min(4, hgt)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${H - pb} Z" fill="var(${s.color})"/>`;
    });
    g += `<rect x="${pl + gw * i}" y="${pt}" width="${gw}" height="${H - pt - pb}" fill="transparent" data-i="${i}"/>`;
    if (rows.length <= 16 && (i % 2 === 0 || rows.length <= 8)) g += `<text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(label(r))}</text>`;
  });
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  setTimeout(() => {
    const el = document.getElementById(id); if (!el) return;
    const tip = el.querySelector('.tip');
    el.querySelectorAll('rect[data-i]').forEach((rc) => {
      rc.addEventListener('mousemove', (e) => {
        const r = rows[rc.dataset.i];
        tip.innerHTML = `<b>${esc(label(r))}</b><br>` + series.map((s) => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(${s.color});margin-right:5px"></i>${esc(s.name)}: <b>${r[s.key] || 0}</b>`).join('<br>');
        const b = el.getBoundingClientRect(); tip.style.display = 'block';
        tip.style.left = Math.min(e.clientX - b.left + 12, b.width - tip.offsetWidth) + 'px'; tip.style.top = (e.clientY - b.top - 10) + 'px';
        rc.setAttribute('fill', 'rgba(127,127,127,.08)');
      });
      rc.addEventListener('mouseleave', () => { tip.style.display = 'none'; rc.setAttribute('fill', 'transparent'); });
    });
  });
  return h`<div class="legend" style="margin-bottom:6px">${series.map((s) => h`<span><i style="background:var(${s.color})"></i>${s.name}</span>`)}</div>
    <div class="chart" id="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${series.map((s) => s.name).join(' and ')} by day">${raw(g)}</svg><div class="tip"></div></div>
    <details style="margin-top:6px"><summary class="muted" style="cursor:pointer;font-size:12px">Show as table</summary>
    <table class="t" style="margin-top:6px"><tr><th>Day</th>${series.map((s) => h`<th class="num">${s.name}</th>`)}</tr>${rows.map((r) => h`<tr><td>${label(r)}</td>${series.map((s) => h`<td class="num">${r[s.key] || 0}</td>`)}</tr>`)}</table></details>`;
}

// ---------- router ----------
const ROUTES = [];
function route(pattern, view, { roles = null, public: pub = false, bare = false } = {}) { ROUTES.push({ pattern, view, roles, pub, bare }); }
let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const hash = location.hash || '#/';
  const path = hash.slice(1).split('?')[0];
  const query = Object.fromEntries(new URLSearchParams(hash.split('?')[1] || ''));
  let match = null; let params = [];
  for (const r of ROUTES) { const m = path.match(r.pattern); if (m) { match = r; params = m.slice(1); break; } }
  if (!match) { location.hash = S.me ? '#/home' : '#/login'; return; }
  if (!match.pub && !S.me) { location.hash = '#/login'; return; }
  if (match.roles && !match.roles.includes(S.me.role)) { location.hash = '#/home'; return; }
  const root = document.getElementById('app');
  if (match.bare) root.innerHTML = '<div class="content">Loading…</div>';
  else { if (!document.querySelector('.shell')) root.innerHTML = str(shell()); updateNav(path); document.getElementById('view').innerHTML = '<div class="muted">Loading…</div>'; }
  pendingHooks.length = 0;
  try {
    const out = await match.view({ params, query, path });
    if (seq !== renderSeq) { pendingHooks.length = 0; return; } // a newer navigation won – drop this view's hooks
    if (match.bare) root.innerHTML = str(out);
    else { document.getElementById('view').innerHTML = str(out); window.scrollTo(0, 0); }
    if (typeof afterRender === 'function') afterRender();
  } catch (e) {
    console.error(e);
    const target = match.bare ? root : document.getElementById('view');
    target.innerHTML = str(h`<div class="notice bad">${e.message}</div>`);
  }
  if (seq === renderSeq) pendingHooks.splice(0).forEach((f) => { try { f(); } catch (e) { console.error(e); } });
}
const pendingHooks = [];
const after = (fn) => pendingHooks.push(fn);
const go = (h2) => { if (location.hash === h2) render(); else location.hash = h2; };
const refresh = () => render();

// ---------- shell & navigation ----------
function navFor(role) {
  const N = (href, icon, label, count) => ({ href, icon, label, count });
  const sip = S.sip ? [N('#/sip', '◎', 'Intelligence (SIP)')] : [];
  switch (role) {
    case 'citizen': return [['', [N('#/home', '⌂', 'Home'), N('#/services', '☰', 'Apply for a service'), N('#/applications', '▤', 'My applications'), N('#/records', '✓', 'My verified records'), N('#/notifications', '✉', 'Messages')]]];
    case 'front_office': return [['Service desk', [N('#/home', '⌂', 'Overview'), N('#/queue', '▤', 'Case queue'), N('#/desk', '＋', 'Assisted application'), N('#/referrals', '⇄', 'Incoming referrals')]]];
    case 'back_office': return [['Back office', [N('#/home', '⌂', 'Overview'), N('#/queue', '▤', 'Case queue'), N('#/referrals', '⇄', 'Incoming referrals')]]];
    case 'finance': return [['Finance', [N('#/home', '⌂', 'Overview'), N('#/finance/payments', '₮', 'Payments'), N('#/finance/reconcile', '⇆', 'Reconciliation')]]];
    case 'ministry_leader': return [['Leadership', [...sip, N('#/queue', '▤', 'Ministry cases'), N('#/referrals', '⇄', 'Referrals to us')]]];
    case 'security': return [['Security services', [...sip, N('#/sip/links', '⌘', 'Link analysis')]]];
    case 'executive': return [['Executive', [...sip, N('#/sip/history', '↗', 'Daily snapshots')]]];
    case 'admin': return [['Administration', [N('#/home', '⌂', 'Overview'), N('#/admin/rollout', '◷', 'Rollout phases'), N('#/admin/services', '☰', 'Services'), N('#/admin/agencies', '▦', 'Agencies'),
      N('#/admin/records', '✓', 'Record sharing'), N('#/admin/users', '☺', 'Users'), N('#/admin/registry', '◉', 'Civil registry'), N('#/admin/integration', '⚿', 'API keys'),
      N('#/admin/providers', '₮', 'Payment providers'), N('#/admin/audit', '≡', 'Audit log'), N('#/admin/sms', '✉', 'SMS')]], ['Oversight', [...sip, N('#/finance/payments', '₮', 'Payments')]]];
    default: return [];
  }
}
function shell() {
  const u = S.me;
  return h`<div class="shell"><aside class="sidebar" id="sidebar">
    <div class="brand"><div class="brand-mark">IGP</div><div><b>Integrated Government</b><span>Zanzibar Moja</span></div></div>
    <nav class="nav">${navFor(u.role).map(([g, items]) => h`${g ? h`<div class="nav-group">${g}</div>` : ''}${items.map((i) => h`<a href="${i.href}" data-nav="${i.href}"><span aria-hidden="true" style="width:16px;text-align:center">${i.icon}</span>${i.label}</a>`)}`)}
      <div class="nav-group">Account</div><a href="#/account" data-nav="#/account"><span style="width:16px;text-align:center">⚙</span>Account</a>
      <a href="#/verify" data-nav="#/verify"><span style="width:16px;text-align:center">⌕</span>Verify a document</a></nav>
    <div class="me"><b>${u.full_name}</b><br><span class="muted">${u.role_label}${u.agency_name ? ' · ' + u.agency_name : ''}</span><br>
      <button class="btn link" id="logout" style="margin-top:6px">Sign out</button></div></aside>
    <div class="main"><header class="topbar"><button class="btn small menu" id="menu" aria-label="Menu">☰</button>
      <div class="muted" style="font-size:12.5px">Revolutionary Government of Zanzibar · <b class="t2">Mifumo Zinasomana. Zanzibar Moja.</b></div><div class="spacer"></div>
      <button class="btn small" id="theme" title="Toggle theme">◐</button></header>
      <main class="content" id="view"></main></div></div>`;
}
function updateNav(path) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const p = a.dataset.nav.slice(1);
    a.classList.toggle('active', path === p || (p !== '/home' && path.startsWith(p + '/')) || (p === '/queue' && path.startsWith('/app/')));
  });
  document.getElementById('sidebar').classList.remove('open');
}
document.addEventListener('click', async (e) => {
  if (e.target.closest('#menu')) document.getElementById('sidebar').classList.toggle('open');
  if (e.target.closest('#logout')) { await api('/auth/logout', { method: 'POST' }); S.me = null; document.getElementById('app').innerHTML = ''; go('#/login'); }
  if (e.target.closest('#theme')) {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('igp-theme', next); } catch {}
  }
  const rowLink = e.target.closest('tr[data-href]'); if (rowLink && !e.target.closest('a,button')) go(rowLink.dataset.href);
});
try { const t = localStorage.getItem('igp-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}

async function boot() {
  const r = await api('/auth/me');
  S.me = r.user; S.phases = r.phases; S.sip = r.sip_enabled;
  document.getElementById('app').innerHTML = '';
}
window.addEventListener('hashchange', render);
