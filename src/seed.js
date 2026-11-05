'use strict';
/*
 * Reference data (agencies, services, record types, access grants, payment providers, staff accounts) is always
 * created. Sample citizens, businesses and historical cases are added unless IGP_SAMPLE_DATA=0, so dashboards have
 * something to show on first start. `npm run seed` wipes the database and re-creates everything.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, one, run, tx, setSetting, DATA_DIR, DB_FILE } = require('./db');
const { hashPassword, newReference, newControlNumber, sha256 } = require('./lib/core');

const DEFAULT_PASSWORD = process.env.IGP_DEFAULT_PASSWORD || 'Zanzibar@2026';

const AGENCIES = [
  ['ZCSRA', 'Zanzibar Civil Status Registration Agency', 'agency'],
  ['BPRA', 'Business and Property Registration Agency', 'agency'],
  ['ZRB', 'Zanzibar Revenue Board', 'agency'],
  ['ZMC', 'Zanzibar Municipal Council', 'local_government'],
  ['FRF', 'Zanzibar Fire and Rescue Force', 'department'],
  ['ZFDA', 'Zanzibar Food and Drugs Agency', 'agency'],
  ['MOH', 'Ministry of Health', 'ministry'],
  ['COL', 'Commission for Lands', 'department'],
  ['ZEMA', 'Zanzibar Environmental Management Authority', 'agency'],
];

const RECORD_TYPES = [
  ['national_id', 'ZanID (national identity)', 'ZCSRA'],
  ['birth_cert', 'Birth certificate', 'ZCSRA'],
  ['business_registration', 'Business registration certificate', 'BPRA'],
  ['tin', 'Taxpayer identification (TIN) certificate', 'ZRB'],
  ['tax_clearance', 'Tax clearance certificate', 'ZRB'],
  ['business_licence', 'Business licence', 'ZMC'],
  ['fire_certificate', 'Fire safety certificate', 'FRF'],
  ['food_hygiene', 'Food hygiene certificate', 'ZFDA'],
  ['land_title', 'Certificate of right of occupancy', 'COL'],
  ['building_permit', 'Building permit', 'COL'],
  ['eia_certificate', 'Environmental impact certificate', 'ZEMA'],
];

const GRANTS = {
  ZMC: ['national_id', 'business_registration', 'tin', 'tax_clearance', 'fire_certificate', 'food_hygiene'],
  FRF: ['national_id', 'business_registration', 'business_licence'],
  ZFDA: ['national_id', 'business_registration', 'business_licence'],
  ZRB: ['national_id', 'business_registration', 'business_licence'],
  MOH: ['national_id', 'business_registration', 'food_hygiene'],
  COL: ['national_id', 'land_title', 'eia_certificate'],
  ZEMA: ['national_id', 'business_registration', 'land_title'],
  BPRA: ['national_id', 'tin'],
  ZCSRA: [],
};

const sel = (name, label, options, extra = {}) => ({ name, label, type: 'select', options, required: true, ...extra });
const SERVICES = [
  {
    code: 'BUSINESS_LICENCE', name: 'Business licence', agency: 'ZMC', fee: 150000, subject: 'business', sla: 7, validity: 365, origin: 'digitized',
    description: 'Licence to operate a trading or service business within the municipality. Previously paper forms at the council office.',
    form: [
      sel('activity', 'Business activity', ['Retail shop', 'Restaurant / food service', 'Tour operator', 'Guest house', 'Wholesale', 'Professional services']),
      { name: 'premises_address', label: 'Premises address', type: 'text', required: true, prefill: 'business.address' },
      { name: 'employees', label: 'Number of employees', type: 'number', required: true },
      { name: 'start_date', label: 'Trading start date', type: 'date', required: true },
    ],
    docs: [
      { code: 'owner_id', label: 'Owner ZanID', record_type: 'national_id' },
      { code: 'registration', label: 'Business registration certificate', record_type: 'business_registration' },
      { code: 'tin', label: 'TIN certificate', record_type: 'tin' },
      { code: 'tax_clearance', label: 'Tax clearance certificate', record_type: 'tax_clearance' },
      { code: 'fire', label: 'Fire safety certificate', record_type: 'fire_certificate' },
      { code: 'lease', label: 'Signed premises lease or title' },
    ],
    referrals: ['FRF'], output: 'Business Licence',
  },
  {
    code: 'FIRE_CERTIFICATE', name: 'Fire safety certificate', agency: 'FRF', fee: 50000, subject: 'business', sla: 10, validity: 365, origin: 'digitized',
    description: 'Inspection and certification of business premises for fire safety.',
    form: [
      { name: 'premises_address', label: 'Premises address', type: 'text', required: true, prefill: 'business.address' },
      { name: 'floor_area_m2', label: 'Floor area (m²)', type: 'number', required: true },
      { name: 'extinguishers', label: 'Number of fire extinguishers', type: 'number', required: true },
    ],
    docs: [
      { code: 'registration', label: 'Business registration certificate', record_type: 'business_registration' },
      { code: 'floor_plan', label: 'Floor plan showing exits' },
    ],
    referrals: [], output: 'Fire Safety Certificate',
  },
  {
    code: 'FOOD_HYGIENE', name: 'Food hygiene certificate', agency: 'ZFDA', fee: 50000, subject: 'business', sla: 14, validity: 365, origin: 'digitized',
    description: 'Certification for premises that prepare, store or sell food.',
    form: [
      { name: 'premises_address', label: 'Premises address', type: 'text', required: true, prefill: 'business.address' },
      { name: 'food_handlers', label: 'Number of food handlers', type: 'number', required: true },
      sel('category', 'Premises category', ['Restaurant', 'Hotel kitchen', 'Bakery', 'Food store', 'Street vending']),
    ],
    docs: [
      { code: 'registration', label: 'Business registration certificate', record_type: 'business_registration' },
      { code: 'medical', label: 'Food handlers’ medical certificates' },
    ],
    referrals: ['MOH'], output: 'Food Hygiene Certificate',
  },
  {
    code: 'TAX_CLEARANCE', name: 'Tax clearance certificate', agency: 'ZRB', fee: 0, subject: 'business', sla: 3, validity: 365, origin: 'integrated',
    description: 'Confirmation that a business has no outstanding tax obligations. Already online – now integrated.',
    form: [{ name: 'purpose', label: 'Purpose', type: 'select', options: ['Licence application', 'Tender', 'Bank loan', 'Other'], required: true }],
    docs: [{ code: 'tin', label: 'TIN certificate', record_type: 'tin' }],
    referrals: [], output: 'Tax Clearance Certificate',
  },
  {
    code: 'BUILDING_PERMIT', name: 'Building permit', agency: 'COL', fee: 200000, subject: 'person', sla: 30, validity: 730, origin: 'digitized',
    description: 'Permission to construct or extend a building on a registered plot.',
    form: [
      { name: 'plot_number', label: 'Plot number', type: 'text', required: true },
      sel('building_use', 'Building use', ['Residential', 'Commercial', 'Mixed use', 'Tourism']),
      { name: 'floors', label: 'Number of floors', type: 'number', required: true },
      { name: 'description', label: 'Description of works', type: 'textarea', required: true },
    ],
    docs: [
      { code: 'owner_id', label: 'Applicant ZanID', record_type: 'national_id' },
      { code: 'title', label: 'Certificate of right of occupancy', record_type: 'land_title' },
      { code: 'drawings', label: 'Architectural drawings' },
    ],
    referrals: ['ZEMA', 'FRF'], output: 'Building Permit',
  },
  {
    code: 'BIRTH_CERT', name: 'Birth certificate', agency: 'ZCSRA', fee: 5000, subject: 'person', sla: 5, validity: null, origin: 'integrated',
    description: 'Registration of a birth and issue of a birth certificate, applied for by a parent.',
    form: [
      { name: 'child_name', label: 'Child’s full name', type: 'text', required: true },
      { name: 'child_dob', label: 'Child’s date of birth', type: 'date', required: true },
      sel('sex', 'Sex', ['Female', 'Male']),
      { name: 'place_of_birth', label: 'Place of birth (facility)', type: 'text', required: true },
    ],
    docs: [
      { code: 'parent_id', label: 'Parent ZanID', record_type: 'national_id' },
      { code: 'notification', label: 'Health facility birth notification' },
    ],
    referrals: [], output: 'Birth Certificate',
  },
  {
    code: 'EIA_CERTIFICATE', name: 'Environmental impact certificate', agency: 'ZEMA', fee: 300000, subject: 'business', sla: 45, validity: 1095, origin: 'digitized',
    description: 'Environmental approval for projects listed under the environmental management regulations.',
    form: [
      { name: 'project_name', label: 'Project name', type: 'text', required: true },
      { name: 'location', label: 'Project location', type: 'text', required: true },
      { name: 'investment_tzs', label: 'Investment value (TZS)', type: 'number', required: true },
    ],
    docs: [
      { code: 'registration', label: 'Business registration certificate', record_type: 'business_registration' },
      { code: 'brief', label: 'Project brief' },
    ],
    referrals: ['COL'], output: 'Environmental Impact Certificate',
  },
];

const STAFF = [
  ['admin', 'System Administrator', 'admin', null],
  ['executive', 'Office of the President – Delivery Unit', 'executive', null],
  ['security', 'Security Services Analyst', 'security', null],
  ['finance', 'Treasury Finance Officer', 'finance', null],
  ['zmc.leader', 'Director, Zanzibar Municipal Council', 'ministry_leader', 'ZMC'],
  ['zmc.desk', 'Mwanaisha Ali (ZMC Service Desk)', 'front_office', 'ZMC'],
  ['zmc.officer', 'Khamis Said (ZMC Licensing)', 'back_office', 'ZMC'],
  ['fire.desk', 'Fatma Omar (Fire Service Desk)', 'front_office', 'FRF'],
  ['fire.officer', 'Inspector Salum Haji', 'back_office', 'FRF'],
  ['fire.leader', 'Commissioner, Fire and Rescue', 'ministry_leader', 'FRF'],
  ['zfda.desk', 'Zuhura Mussa (ZFDA Desk)', 'front_office', 'ZFDA'],
  ['zfda.officer', 'Dr. Asha Rashid (ZFDA)', 'back_office', 'ZFDA'],
  ['zfda.leader', 'Director General, ZFDA', 'ministry_leader', 'ZFDA'],
  ['moh.officer', 'Dr. Hamad Kombo (Ministry of Health)', 'back_office', 'MOH'],
  ['moh.leader', 'Principal Secretary, Ministry of Health', 'ministry_leader', 'MOH'],
  ['zrb.desk', 'Riziki Ame (ZRB Desk)', 'front_office', 'ZRB'],
  ['zrb.officer', 'Yusuf Makame (ZRB)', 'back_office', 'ZRB'],
  ['zrb.leader', 'Commissioner General, ZRB', 'ministry_leader', 'ZRB'],
  ['col.desk', 'Halima Vuai (Lands Desk)', 'front_office', 'COL'],
  ['col.officer', 'Eng. Bakari Shaame (Lands)', 'back_office', 'COL'],
  ['col.leader', 'Commissioner for Lands', 'ministry_leader', 'COL'],
  ['zema.officer', 'Maryam Suleiman (ZEMA)', 'back_office', 'ZEMA'],
  ['zema.leader', 'Director General, ZEMA', 'ministry_leader', 'ZEMA'],
  ['zcsra.desk', 'Saada Hamad (Civil Registration Desk)', 'front_office', 'ZCSRA'],
  ['zcsra.officer', 'Ali Khamis (Civil Registration)', 'back_office', 'ZCSRA'],
  ['zcsra.leader', 'Registrar General', 'ministry_leader', 'ZCSRA'],
  ['bpra.officer', 'Neema Juma (BPRA)', 'back_office', 'BPRA'],
];

const FIRST = ['Amina', 'Juma', 'Fatma', 'Said', 'Mwanaisha', 'Hassan', 'Zainab', 'Omar', 'Rehema', 'Abdalla', 'Halima', 'Salim', 'Mariam', 'Haji', 'Khadija', 'Suleiman', 'Asha', 'Mussa', 'Mwajuma', 'Ramadhan', 'Saada', 'Makame', 'Tatu', 'Vuai'];
const LAST = ['Hassan', 'Juma', 'Ali', 'Omar', 'Khamis', 'Said', 'Haji', 'Mohamed', 'Abdalla', 'Kombo', 'Makame', 'Suleiman', 'Rashid', 'Mussa', 'Vuai', 'Shaame'];
const DISTRICTS = ['Mjini', 'Magharibi A', 'Magharibi B', 'Kaskazini A', 'Kaskazini B', 'Kati', 'Kusini', 'Chake Chake', 'Wete', 'Micheweni', 'Mkoani'];
const STREETS = ['Darajani', 'Malindi', 'Mwanakwerekwe', 'Kiembe Samaki', 'Mombasa', 'Amani', 'Mlandege', 'Kikwajuni', 'Shangani', 'Forodhani', 'Jang’ombe', 'Mtoni'];
const BIZ = ['Spice House', 'Coral Tours', 'Stone Town Bakery', 'Ocean View Guest House', 'Pemba Clove Traders', 'Kizimkazi Dive Centre', 'Mnazi Mmoja Pharmacy',
  'Darajani General Store', 'Forodhani Grill', 'Nungwi Beach Lodge', 'Malindi Hardware', 'Jambiani Seaweed Co-op', 'Kendwa Water Sports', 'Paje Kite School',
  'Michenzani Electronics', 'Mtoni Furniture Works', 'Chake Fresh Market', 'Wete Fish Supplies', 'Tumbatu Ferry Services', 'Bububu Auto Garage'];
const SECTORS = ['Retail', 'Tourism', 'Food service', 'Hospitality', 'Trade', 'Services', 'Manufacturing'];

let rng = 20261105;
const rand = () => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng / 2147483648; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const ago = (days, hours = 0) => new Date(Date.now() - days * 864e5 - hours * 36e5).toISOString().replace('T', ' ').slice(0, 19);
const phone = () => `2557${pick(['7', '1', '5', '4'])}${String(Math.floor(rand() * 1e7)).padStart(7, '0')}`;

function wipe() {
  db.close();
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) fs.rmSync(f, { force: true });
  fs.rmSync(path.join(DATA_DIR, 'uploads'), { recursive: true, force: true });
}

function seed({ sample = true } = {}) {
  const ids = {};
  tx(() => {
    setSetting('phases', {
      digitize: { label: 'Digitize manual services', live: true },
      phase1: { label: 'Phase 1 – Intra-governmental integration', live: true },
      phase2: { label: 'Phase 2 – Mobile money payments (G2T)', live: true },
      phase3: { label: 'Phase 3 – Application portal and workflow', live: true },
    });
    for (const [code, name, kind] of AGENCIES) ids[code] = Number(run('INSERT INTO agencies(code, name, kind, integrated) VALUES(?,?,?,1)', code, name, kind).lastInsertRowid);
    for (const [code, name, owner] of RECORD_TYPES) run('INSERT INTO record_types(code, name, owner_agency_id) VALUES(?,?,?)', code, name, ids[owner]);
    for (const [ag, types] of Object.entries(GRANTS)) for (const t of types) run('INSERT INTO record_access_grants(agency_id, record_type) VALUES(?,?)', ids[ag], t);
    for (const s of SERVICES) {
      s.id = Number(run(`INSERT INTO services(code, name, description, agency_id, fee, subject, form_schema, required_docs, referral_agencies, sla_days, output_name, output_validity_days, origin)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, s.code, s.name, s.description, ids[s.agency], s.fee, s.subject, JSON.stringify(s.form), JSON.stringify(s.docs),
      JSON.stringify(s.referrals), s.sla, s.output, s.validity, s.origin).lastInsertRowid);
    }
    for (const [code, name] of [['mpesa', 'M-Pesa'], ['mixx', 'Mixx by Yas'], ['airtel', 'Airtel Money'], ['halopesa', 'HaloPesa']]) {
      run("INSERT INTO payment_providers(code, name, mode, callback_secret) VALUES(?,?, 'sandbox', ?)", code, name, crypto.randomBytes(24).toString('hex'));
    }
    const pw = hashPassword(DEFAULT_PASSWORD);
    for (const [u, n, role, ag] of STAFF) run('INSERT INTO users(username, password_hash, full_name, role, agency_id) VALUES(?,?,?,?,?)', u, pw, n, role, ag ? ids[ag] : null);
  });
  if (sample) seedSample(ids);
  return ids;
}

function seedSample(ids) {
  const pw = hashPassword(DEFAULT_PASSWORD);
  const svc = Object.fromEntries(SERVICES.map((s) => [s.code, s]));
  const persons = []; const businesses = [];
  const uploads = path.join(DATA_DIR, 'uploads'); fs.mkdirSync(uploads, { recursive: true });

  tx(() => {
    const addPerson = (name, dob, ph, district, street) => {
      const zan = String(100000000 + persons.length * 7919 + 13).padStart(9, '0');
      const id = Number(run('INSERT INTO persons(zan_id, full_name, dob, sex, phone, address, district) VALUES(?,?,?,?,?,?,?)',
        zan, name, dob, rand() > 0.5 ? 'F' : 'M', ph, `${street}, ${district}`, district).lastInsertRowid);
      run("INSERT INTO records(record_type, person_id, issuing_agency_id, number, issued_at) VALUES('national_id', ?, ?, ?, ?)", id, ids.ZCSRA, zan, ago(2000));
      const p = { id, zan, name, phone: ph }; persons.push(p); return p;
    };
    const addBiz = (owner, name, sector, street, opts = {}) => {
      const brn = `Z${String(2000000 + businesses.length * 3571).slice(0, 7)}`;
      const tin = `1${String(10000000 + businesses.length * 48611).slice(0, 8)}`;
      const id = Number(run('INSERT INTO businesses(brn, name, owner_person_id, tin, sector, address, phone, registered_at) VALUES(?,?,?,?,?,?,?,?)',
        brn, name, owner.id, tin, sector, `${street} Street, Zanzibar`, owner.phone, ago(400 + businesses.length * 20)).lastInsertRowid);
      run("INSERT INTO records(record_type, business_id, issuing_agency_id, number, data, issued_at) VALUES('business_registration', ?, ?, ?, ?, ?)", id, ids.BPRA, brn, JSON.stringify({ name, sector }), ago(400));
      run("INSERT INTO records(record_type, business_id, issuing_agency_id, number, issued_at) VALUES('tin', ?, ?, ?, ?)", id, ids.ZRB, tin, ago(390));
      if (opts.taxClear !== false) run("INSERT INTO records(record_type, business_id, issuing_agency_id, number, valid_until, issued_at) VALUES('tax_clearance', ?, ?, ?, ?, ?)", id, ids.ZRB, `TC/${brn}`, ago(-200).slice(0, 10), ago(160));
      if (opts.fire) run("INSERT INTO records(record_type, business_id, issuing_agency_id, number, valid_until, issued_at) VALUES('fire_certificate', ?, ?, ?, ?, ?)", id, ids.FRF, `FRF/${brn}`, ago(-250).slice(0, 10), ago(115));
      const b = { id, brn, name, owner }; businesses.push(b); return b;
    };

    // Named account holders used in the walkthrough
    const amina = addPerson('Amina Juma Hassan', '1988-03-14', '255777123456', 'Mjini', 'Darajani');
    const said = addPerson('Said Omar Khamis', '1979-11-02', '255715234567', 'Magharibi A', 'Mwanakwerekwe');
    addBiz(amina, 'Amina Spice House', 'Retail', 'Darajani', { fire: true });
    addBiz(said, 'Coral Tours Zanzibar', 'Tourism', 'Shangani', { fire: true });
    run("INSERT INTO records(record_type, person_id, issuing_agency_id, number, data, issued_at) VALUES('land_title', ?, ?, 'CRO/MJ/0042/2015', ?, ?)", said.id, ids.COL, JSON.stringify({ plot: 'MJ/0042' }), ago(3000));
    run("INSERT INTO users(username, password_hash, full_name, role, person_id, phone) VALUES('amina', ?, ?, 'citizen', ?, ?)", pw, amina.name, amina.id, amina.phone);
    run("INSERT INTO users(username, password_hash, full_name, role, person_id, phone) VALUES('said', ?, ?, 'citizen', ?, ?)", pw, said.name, said.id, said.phone);

    // Registry population (people without portal accounts – they can self-register with ZanID + date of birth)
    for (let i = 0; i < 34; i++) {
      const p = addPerson(`${pick(FIRST)} ${pick(FIRST)} ${pick(LAST)}`, `${1960 + Math.floor(rand() * 40)}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`,
        phone(), pick(DISTRICTS), pick(STREETS));
      if (i < 18) addBiz(p, BIZ[i + 2] || `${p.name.split(' ')[0]} Enterprises`, pick(SECTORS), pick(STREETS), { fire: rand() > 0.4, taxClear: rand() > 0.15 });
      if (i % 5 === 0) run("INSERT INTO records(record_type, person_id, issuing_agency_id, number, issued_at) VALUES('land_title', ?, ?, ?, ?)", p.id, ids.COL, `CRO/${i}/${2010 + i % 12}`, ago(2500));
    }
    // risk pattern: three identities registered with one phone number
    const shared = '255778900111';
    for (const i of [10, 11, 12]) { run('UPDATE persons SET phone = ? WHERE id = ?', shared, persons[i].id); persons[i].phone = shared; }

    // ---- historical cases ----
    const officer = (code) => one("SELECT id FROM users WHERE role = 'back_office' AND agency_id = ?", ids[code]).id;
    const desk = (code) => { const u = one("SELECT id FROM users WHERE role = 'front_office' AND agency_id = ?", ids[code]); return u ? u.id : officer(code); };
    const ev = (appId, kind, msg, when, actor, agency, vis = 1) => run('INSERT INTO application_events(application_id, kind, message, actor_id, agency_id, visible_to_applicant, created_at) VALUES(?,?,?,?,?,?,?)', appId, kind, msg, actor, agency, vis, when);

    const plan = [];
    const bizSvcs = ['BUSINESS_LICENCE', 'FIRE_CERTIFICATE', 'FOOD_HYGIENE', 'TAX_CLEARANCE', 'EIA_CERTIFICATE'];
    for (let i = 0; i < 70; i++) {
      const code = i % 4 === 0 ? pick(['BUILDING_PERMIT', 'BIRTH_CERT']) : pick(bizSvcs);
      const s = svc[code];
      const ageDays = Math.floor(rand() * 40);
      const roll = rand();
      let status;
      if (ageDays < 2) status = pick(['submitted', 'submitted', 'in_review']);
      else if (roll < 0.5) status = 'issued';
      else if (roll < 0.58) status = 'rejected';
      else status = pick(['in_review', 'in_review', 'awaiting_applicant', 'awaiting_payment', 'approved', 'submitted']);
      let age = ageDays;
      if (['in_review', 'awaiting_applicant', 'awaiting_payment', 'approved', 'submitted'].includes(status)) {
        age = Math.floor(rand() * s.sla * (rand() < 0.25 ? 2.5 : 0.9)); // most open cases within standard, some late
      }
      const dur = Math.max(1, Math.round(s.sla * (0.3 + rand() * 0.9)));
      if (['issued', 'rejected'].includes(status)) age = dur + Math.floor(rand() * 30);
      plan.push({ code, s, ageDays: age, status, dur });
    }
    const used = new Set();
    for (const p of plan) {
      const s = p.s;
      if (['issued', 'rejected'].includes(p.status) && p.ageDays - p.dur < 0) p.status = 'in_review';
      let person, biz = null;
      if (s.subject === 'business') {
        const cands = businesses.slice(2).filter((b) => !used.has(`${s.code}:${b.id}`));
        if (!cands.length) continue;
        biz = pick(cands); person = biz.owner;
      } else {
        const cands = persons.slice(2).filter((x) => !used.has(`${s.code}:${x.id}`));
        person = pick(cands);
      }
      if (['submitted', 'in_review', 'awaiting_applicant', 'awaiting_payment', 'approved'].includes(p.status)) used.add(`${s.code}:${biz ? biz.id : person.id}`);
      const created = ago(p.ageDays, Math.floor(rand() * 10));
      const ref = newReference();
      const channel = rand() < 0.3 ? 'desk' : 'online';
      const form = {};
      for (const f of s.form) {
        form[f.name] = f.type === 'select' ? pick(f.options) : f.type === 'number' ? 1 + Math.floor(rand() * 20)
          : f.type === 'date' ? ago(-10).slice(0, 10) : f.prefill === 'business.address' ? `${pick(STREETS)} Street, Zanzibar`
            : f.name === 'child_name' ? `${pick(FIRST)} ${person.name.split(' ')[0]}` : f.name === 'plot_number' ? `MJ/${100 + Math.floor(rand() * 800)}`
              : f.name === 'project_name' ? `${pick(['Beach', 'Eco', 'Coastal', 'Harbour'])} ${pick(['Resort', 'Lodge', 'Warehouse', 'Marina'])}` : `${pick(STREETS)}`;
      }
      const reused = s.docs.filter((d) => d.record_type).map((d) => ({ code: d.code, label: d.label }));
      const closedDays = Math.max(0, p.ageDays - p.dur);
      const closed = ['issued', 'rejected'].includes(p.status) ? ago(closedDays) : null;
      const appId = Number(run(`INSERT INTO applications(reference, service_id, person_id, business_id, channel, form_data, reused_records, status, created_at, updated_at, closed_at, submitted_by, decision_note)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, ref, s.id, person.id, biz ? biz.id : null, channel, JSON.stringify(form), JSON.stringify(reused), p.status,
      created, closed || created, closed, channel === 'desk' ? desk(s.agency) : null, p.status === 'rejected' ? 'Premises did not meet inspection requirements' : null).lastInsertRowid);
      ev(appId, 'submitted', channel === 'desk' ? 'Submitted at the service desk on behalf of the applicant' : 'Application submitted online', created, null, null);
      // uploaded documents (non-record ones)
      for (const d of s.docs.filter((x) => !x.record_type)) {
        if (p.status === 'awaiting_applicant') continue;
        const content = `Sample ${d.label} for ${ref}`;
        const name = crypto.randomBytes(16).toString('hex') + '.pdf';
        fs.writeFileSync(path.join(uploads, name), samplePdf(content));
        run('INSERT INTO documents(application_id, doc_code, filename, stored_name, mime, size, sha256, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
          appId, d.code, `${d.code}.pdf`, name, 'application/pdf', samplePdf(content).length, sha256(samplePdf(content)), 'accepted', created);
      }
      if (p.status === 'awaiting_applicant') {
        const d = s.docs.find((x) => !x.record_type);
        run('INSERT INTO document_requests(application_id, doc_code, label, message, requested_by, created_at) VALUES(?,?,?,?,?,?)', appId, d.code, d.label, 'Please upload a clear signed copy', desk(s.agency), ago(p.ageDays - 1));
        ev(appId, 'document_requested', `Document requested: ${d.label}`, ago(p.ageDays - 1), desk(s.agency), ids[s.agency]);
      }
      const routed = p.status !== 'submitted' && p.status !== 'awaiting_applicant';
      if (routed) ev(appId, 'routed', 'Submission checked and routed for review', ago(p.ageDays, -3), desk(s.agency), ids[s.agency]);
      if (routed) {
        for (const rc of s.referrals) {
          const answered = p.status !== 'in_review' || rand() < 0.4;
          const outcome = p.status === 'rejected' && rand() < 0.5 ? 'objection' : 'cleared';
          run(`INSERT INTO referrals(application_id, from_agency_id, to_agency_id, question, status, outcome, note, created_by, responded_by, created_at, responded_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`, appId, ids[s.agency], ids[rc], `Standard ${s.name} clearance`, answered ? 'answered' : 'open', answered ? outcome : null,
          answered && outcome === 'objection' ? 'Inspection found deficiencies' : null, desk(s.agency), answered ? officer(rc) : null, ago(p.ageDays, -4), answered ? ago(Math.max(0, p.ageDays - 2)) : null);
          ev(appId, 'referred', `Referred to ${AGENCIES.find((a) => a[0] === rc)[1]} for clearance`, ago(p.ageDays, -4), desk(s.agency), ids[s.agency]);
        }
      }
      if (s.fee > 0) {
        const paid = ['issued', 'approved'].includes(p.status) || (p.status === 'in_review' && rand() < 0.3);
        const prov = pick(['mpesa', 'mixx', 'airtel', 'halopesa']);
        const paidAt = paid ? (closed ? ago(closedDays + 1) : ago(Math.max(0, p.ageDays - 2))) : null;
        const pid = Number(run(`INSERT INTO payments(application_id, control_number, amount, status, provider, msisdn, provider_ref, receipt_no, paid_amount, created_at, initiated_at, paid_at, reconciled, reconciled_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, appId, newControlNumber(), s.fee, paid ? 'paid' : 'unpaid', paid ? prov : null, paid ? person.phone : null,
        paid ? `${prov.toUpperCase()}${crypto.randomBytes(5).toString('hex').toUpperCase()}` : null, null, paid ? s.fee : null, created, paidAt, paidAt,
        paid && p.ageDays > 3 ? 1 : 0, paid && p.ageDays > 3 ? paidAt : null).lastInsertRowid);
        if (paid) {
          run('UPDATE payments SET receipt_no = ? WHERE id = ?', `RCT-${new Date().getFullYear()}-${String(pid).padStart(7, '0')}`, pid);
          ev(appId, 'paid', 'Fee paid by mobile money – receipt issued', paidAt, null, null);
        }
      }
      if (['awaiting_payment', 'approved', 'issued'].includes(p.status)) ev(appId, 'approved', 'Application approved', closed || ago(Math.max(0, p.ageDays - 3)), officer(s.agency), ids[s.agency]);
      if (p.status === 'rejected') ev(appId, 'rejected', 'Application rejected – Premises did not meet inspection requirements', closed, officer(s.agency), ids[s.agency]);
      if (p.status === 'issued') {
        const num = `${s.code}/${new Date().getFullYear()}/${String(appId).padStart(6, '0')}`;
        const validUntil = s.validity ? new Date(Date.now() + (s.validity - closedDays) * 864e5).toISOString().slice(0, 10) : null;
        run('INSERT INTO issued_documents(application_id, number, title, verification_code, data, issued_by, issued_at, valid_until) VALUES(?,?,?,?,?,?,?,?)',
          appId, num, s.output, crypto.randomBytes(6).toString('hex').toUpperCase(),
          JSON.stringify({ reference: ref, holder: person.name, zan_id: person.zan, business: biz && biz.name, brn: biz && biz.brn, service: s.name, agency: AGENCIES.find((a) => a[0] === s.agency)[1], form }),
          officer(s.agency), closed, validUntil);
        run('INSERT INTO records(record_type, person_id, business_id, issuing_agency_id, number, valid_until, issued_at) VALUES(?,?,?,?,?,?,?)',
          s.code.toLowerCase(), biz ? null : person.id, biz ? biz.id : null, ids[s.agency], num, validUntil, closed);
        ev(appId, 'issued', `${s.output} ${num} issued under reference ${ref}`, closed, officer(s.agency), ids[s.agency]);
      }
      if (p.ageDays > s.sla * 2 && ['in_review', 'submitted'].includes(p.status) && rand() < 0.5) run('UPDATE applications SET escalated = 1 WHERE id = ?', appId);
    }

    // risk pattern: the same drawings file submitted by two different applicants
    const twins = one(`SELECT d1.id AS a, d2.id AS b FROM documents d1 JOIN applications a1 ON a1.id = d1.application_id
      JOIN documents d2 ON d2.doc_code = d1.doc_code AND d2.id > d1.id JOIN applications a2 ON a2.id = d2.application_id
      WHERE a1.person_id <> a2.person_id LIMIT 1`);
    if (twins) {
      const src = one('SELECT * FROM documents WHERE id = ?', twins.a);
      const dst = one('SELECT * FROM documents WHERE id = ?', twins.b);
      fs.copyFileSync(path.join(uploads, src.stored_name), path.join(uploads, dst.stored_name));
      run('UPDATE documents SET sha256 = ?, size = ? WHERE id = ?', src.sha256, src.size, dst.id);
    }
  });
}

// Minimal valid one-page PDF containing a line of text
function samplePdf(text) {
  const t = text.replace(/[()\\]/g, '');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 14 Tf 60 780 Td (${t}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

if (require.main === module) {
  // `npm run seed` – wipe and rebuild in a fresh process so the database handle is clean
  wipe();
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--no-warnings', '-e',
    `require(${JSON.stringify(path.join(__dirname, 'server.js'))}).createApp();
     const sip = require(${JSON.stringify(path.join(__dirname, 'lib', 'sip.js'))}); sip.runRules(); sip.snapshot();
     console.log('Database seeded. Default password for seeded accounts: ${DEFAULT_PASSWORD}');`], { stdio: 'inherit', env: process.env });
}

module.exports = { seed, samplePdf, DEFAULT_PASSWORD };
