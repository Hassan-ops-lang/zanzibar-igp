'use strict';
const { one, all, getSetting } = require('../db');
const { parse } = require('./core');

function phaseLive(key) {
  const p = getSetting('phases', {});
  return !!(p[key] && p[key].live);
}

function canAccess(agencyId, recordType) {
  if (!agencyId) return false;
  const rt = one('SELECT owner_agency_id FROM record_types WHERE code = ?', recordType);
  if (rt && rt.owner_agency_id === agencyId) return true;
  return !!one('SELECT 1 FROM record_access_grants WHERE agency_id = ? AND record_type = ?', agencyId, recordType);
}

function shapeRecord(r) {
  return {
    id: r.id, record_type: r.record_type, type_name: r.type_name, number: r.number, data: parse(r.data, {}),
    issuing_agency: r.agency_name, status: r.status, issued_at: r.issued_at, valid_until: r.valid_until,
    valid: r.status === 'valid' && (!r.valid_until || r.valid_until >= new Date().toISOString().slice(0, 10)),
  };
}

// Records about a person (and their businesses) that `agencyId` is authorised to see.
// agencyId === null means "the subject themselves" (citizens always see their own records).
function recordsFor({ personId, businessId, agencyId, self = false }) {
  const rows = all(`SELECT r.*, t.name AS type_name, a.name AS agency_name FROM records r
    JOIN record_types t ON t.code = r.record_type JOIN agencies a ON a.id = r.issuing_agency_id
    WHERE (r.person_id = ? OR (r.business_id IS NOT NULL AND r.business_id = ?)) ORDER BY r.issued_at DESC`,
  personId || -1, businessId || -1);
  return rows.filter((r) => self || canAccess(agencyId, r.record_type)).map(shapeRecord);
}

// Which required documents for an application are already satisfied by verified records
function resolveRequiredDocs(service, personId, businessId) {
  const required = parse(service.required_docs, []);
  const reuse = phaseLive('phase1');
  const recs = reuse ? recordsFor({ personId, businessId, agencyId: service.agency_id }) : [];
  return required.map((d) => {
    const rec = d.record_type ? recs.find((r) => r.record_type === d.record_type && r.valid) : null;
    return { ...d, satisfied_by_record: rec ? { id: rec.id, number: rec.number, issuing_agency: rec.issuing_agency } : null };
  });
}

function personProfile(personId) {
  const p = one('SELECT * FROM persons WHERE id = ?', personId);
  if (!p) return null;
  p.businesses = all('SELECT * FROM businesses WHERE owner_person_id = ?', personId);
  return p;
}

module.exports = { canAccess, recordsFor, resolveRequiredDocs, personProfile, phaseLive, shapeRecord };
