// src/services/doctor_landing.js
//
// §4.7 first-login landing + soft-nudge predicate. A doctor whose
// onboarding_complete=false AND whose service union (§2.2) is NON-EMPTY should
// be steered to /portal/doctor/services on first login and nudged by the topbar
// banner. Empty-union doctors (Pediatrics/Internal-Medicine escape hatch) must
// NOT be sent there — there is nothing to confirm and onboarding_complete stays
// false, so a redirect would loop. Non-doctors return null so callers keep
// their own getHomeByRole() default.
'use strict';

const { pool } = require('../pg');
const { loadDoctorServiceCatalog } = require('./doctor_service_catalog');

const DOCTOR_SERVICES_PATH = '/portal/doctor/services';
const DOCTOR_HOME_PATH = '/portal/doctor';

// Core predicate: does this user have an unconfirmed, non-empty service union?
// `user` MUST be the DB users row (carries onboarding_complete + specialty_id) —
// the JWT payload does NOT carry onboarding_complete.
async function shouldLandOnServices(user, { client } = {}) {
  if (!user || String(user.role || '').toLowerCase() !== 'doctor') return false;
  // Explicit save already flipped this true — nothing to nudge.
  if (user.onboarding_complete === true) return false;

  const conn = client || (await pool.connect());
  try {
    const catalog = await loadDoctorServiceCatalog(conn, {
      doctorId: String(user.id),
      specialtyId: user.specialty_id ? String(user.specialty_id) : null
    });
    return !catalog.isEmpty;
  } finally {
    if (!client && conn && typeof conn.release === 'function') conn.release();
  }
}

// Landing path for the first-login redirect. Doctor with a non-empty unconfirmed
// union → services; other doctors → dashboard; non-doctors → null (caller keeps
// its own redirect target).
async function resolveDoctorLanding(user, { client } = {}) {
  if (!user || String(user.role || '').toLowerCase() !== 'doctor') return null;
  const land = await shouldLandOnServices(user, { client });
  return land ? DOCTOR_SERVICES_PATH : DOCTOR_HOME_PATH;
}

module.exports = { resolveDoctorLanding, shouldLandOnServices, DOCTOR_SERVICES_PATH, DOCTOR_HOME_PATH };
