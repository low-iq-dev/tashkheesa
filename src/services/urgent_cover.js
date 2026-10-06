'use strict';
// src/services/urgent_cover.js
//
// "Can anyone actually take an Urgent (4-hour) case for this service?"
//
// 6 Oct 2026 — both radiologists confirmed their tiers as standard + VIP, so
// Radiology had no Urgent cover, and the checkout still sold Urgent for it:
// the only gate was the 07:00–19:00 Cairo window. A patient could pay the
// Urgent surcharge for a case no doctor on the platform had agreed to turn
// round in four hours.
//
// The rule mirrors who the broadcast would reach (notify/broadcast.js and
// services/doctor_eligibility.eligibleDoctorClause): an active, approved,
// onboarded, un-paused doctor who holds the service AND lists 'urgent' in
// sla_tiers_supported. A doctor who has never confirmed tiers reads as
// standard-only, exactly as the routing code treats them.
//
// FAILS OPEN on a query error: a database hiccup must not take Urgent off
// sale for every specialty. The error is logged; the next call re-reads.

const D = {
  pg: function () { return require('../pg'); },
  logErrorToDb: function () { return require('../logger').logErrorToDb.apply(null, arguments); }
};
function __setTestDeps(o) { Object.assign(D, o || {}); }

const URGENT_SPELLINGS = ['urgent'];

const COVER_SQL =
  `SELECT DISTINCT ds.service_id
     FROM doctor_services ds
     JOIN users u ON u.id = ds.doctor_id
    WHERE u.role = 'doctor'
      AND COALESCE(u.is_active, true) = true
      AND COALESCE(u.is_paused, false) = false
      AND COALESCE(u.pending_approval, false) = false
      AND COALESCE(u.onboarding_complete, false) = true
      AND COALESCE(u.sla_tiers_supported, '["standard"]'::jsonb) ?| $1`;

/** Set of service ids that have at least one Urgent-capable doctor. null = unknown (query failed). */
async function servicesWithUrgentCover() {
  try {
    const rows = await D.pg().queryAll(COVER_SQL, [URGENT_SPELLINGS]);
    return new Set((rows || []).map(function (r) { return String(r.service_id); }));
  } catch (e) {
    try { D.logErrorToDb(e, { context: 'urgent_cover.servicesWithUrgentCover', category: 'patient_case' }); } catch (_) {}
    return null;
  }
}

/** true when Urgent can be sold for this service (or when cover could not be read). */
async function serviceHasUrgentCover(serviceId) {
  if (!serviceId) return true;
  try {
    const row = await D.pg().queryOne(COVER_SQL + ` AND ds.service_id = $2 LIMIT 1`, [URGENT_SPELLINGS, String(serviceId)]);
    return !!row;
  } catch (e) {
    try { D.logErrorToDb(e, { context: 'urgent_cover.serviceHasUrgentCover', category: 'patient_case', serviceId: serviceId }); } catch (_) {}
    return true;
  }
}

module.exports = { servicesWithUrgentCover, serviceHasUrgentCover, COVER_SQL, __setTestDeps };
